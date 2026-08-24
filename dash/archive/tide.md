# Tide — The Unified Command Surface

*Replace the terminal. Keep the commands.*

**Codename:** Tide
**Reference:** [tide-conversation-log.md](tide-conversation-log.md), [tide-conversation-summary.md](tide-conversation-summary.md) — design conversation
**Prior work:** [tug-conversation.md](tug-conversation.md) — Claude Code transport exploration and UI phases (Phases 1-2c, 3A-3A.7 remain authoritative for completed work)

---

## Vision

### Why now

The command line traces its lineage to 19th-century teleprinters. The modern reimagining is the DEC VT100 — a 1978 terminal that could address cursor positions on a character grid. Typing clipped text commands and getting minimally-formatted text responses was the outside limit of what the hardware could do. Over time, this `tty` model became a standard so successful and so durable that every Linux, Mac, and Unix-like computer still offers pseudo-terminals (`pty`) as a primary interface, and millions of people use shells like Bash and Zsh to get work done every day.

Anthropic took the curious step of adopting the terminal as the user interface for Claude Code — and this turned out to be a brilliant choice. The terminal is all about text, and so are LLMs. Text-only usage patterns and conventions proved to be an excellent way to bring AI assistance to complex software development work.

Two things converged that didn't exist five years ago. First, LLMs made "talk to your computer in natural language" a genuine daily workflow. Claude Code proved that a text-based command interface can orchestrate sophisticated multi-step work — reading files, editing code, running builds, managing git — over a structured protocol that happens to run inside a terminal but doesn't need one. Second, the commands developers actually run have quietly grown structured output capabilities. `git status --porcelain` has existed for years. `cargo --message-format=json` shipped in 2017. Docker, kubectl, npm, aws CLI — all speak JSON now. The ecosystem moved toward machine-readable output because CI/CD pipelines need it. But nobody built a *human-facing* surface that takes advantage of this.

A structured AI protocol on one side. Structured command output on the other. Both being flattened through a 1978 display device.

But the terminal bundles two things we don't typically separate in our minds: the **rendering surface** (the tty/pty/VT100 character grid) and the **command interpreter** (the shell or tool that accepts commands and produces output). The rendering surface is the part stuck in 1978. The command interpreters — shells, compilers, version control, AI assistants — have evolved enormously. They're held back by a display device that can only paint characters into a grid.

We can divide these. Leave the tty/pty behind. Provide a graphical foundation layer for command interpreters — both the shells (Bash, Zsh) and Claude Code.

### What Tide is

Tide is a graphical command surface where humans and AI both issue commands and see results, rendered at the full fidelity of a graphical UI. There is no terminal pane and no AI pane — one surface, one stream of command blocks, each rendered with purpose-built graphical components.

The programs people use most — git, cargo, ls, grep, curl — produce structured or line-oriented output that was only ever flattened into ANSI escape sequences because the terminal was the only display available. Tide provides a better display. For recognized commands, it renders rich graphical components: sortable file listings, clickable commit timelines, syntax-highlighted diffs, build output with source links. For everything else, it renders styled monospace text. The VT100 character grid never appears.

Claude Code already broke free of the terminal with `--output-format stream-json`. It speaks a typed protocol: structured JSON events with semantic meaning. The transport exploration (35 tests) documented this protocol. The tugcast WebSocket layer carries it to tugdeck. This is the proof of concept — a post-terminal command experience that already works.

Tide extends this approach to the shell. The same method — investigate inputs and outputs, define structured events, render graphically — applied to bash, zsh, and the ~20 commands that cover 80% of developer shell usage. The adapter registry auto-detects known commands and produces structured data without the user asking for it. This is the gap nobody else fills: Nushell, PowerShell, and Jupyter all treat external commands as opaque text. Tide recognizes them and renders them richly.

### Why this approach works

Previous attempts at graphical shells failed because they broke compatibility. TermKit (2011) tried to replace everything at once and couldn't run real commands. Tide's approach avoids this through three design choices:

**We're paying the rendering cost anyway.** The Claude Code transport exploration proved that a graphical UI must rebuild ~30 features from scratch (U1-U23, C1-C15) because terminal-only commands produce nothing in stream-json mode. That's not a bug — it's evidence that the terminal was always doing two jobs (interpreting commands *and* rendering output) and when you strip the terminal, you have to replace both. If you're building that rendering layer for Claude Code, extending it to shell commands is incremental. The marginal cost of a git status adapter is small compared to the cost of the conversation rendering engine.

**The method is the same for both halves.** The Claude Code side was built by investigating the stream-json protocol — mapping every event type, documenting inputs and outputs, then building renderers for each. The shell side uses the same method: for each command we want on the surface, investigate its structured output modes, define the adapter, build the renderer. Expand the "UI Must Build" set to encompass the most-used shell commands. Do for each what we did for each Claude Code event type.

**Full compatibility via hidden pty means nothing breaks.** Tide runs unmodified bash/zsh. Every command works on day one. The worst case for an unrecognized command is styled monospace text — which is already better than most terminal emulators' rendering. You can paste any command from Stack Overflow and it runs. Adapters add progressive richness without ever sacrificing compatibility.

**The adapter model is incremental — focus on the fat part of the curve.** You don't need 20 adapters to ship. Git alone covers 15-25% of developer shell usage. Add cargo and you have the two tools a Rust developer uses most. Each adapter makes the surface meaningfully better for some slice of daily work, and the fallback handles everything else. The long tail of obscure commands never goes away, but the fat part under the curve — the 20 commands that cover 80% of usage — isn't daunting. The registry grows over time, and the fallback (styled monospace with SGR color mapping) is genuinely good for everything else.

---

## What We're Replacing

Understanding the pty architecture explains why the terminal is limited and what Tide must do differently.

### The pty abstraction

A pty (pseudo-terminal) is a kernel-level bidirectional byte pipe with a **line discipline** in the middle. `posix_openpt()` creates a master/slave pair. The terminal emulator holds the master fd; the shell gets the slave fd as its stdin/stdout/stderr.

The line discipline handles: character echo, line editing (backspace, Ctrl-U), and signal generation (Ctrl-C → SIGINT, Ctrl-Z → SIGTSTP). When a program calls `cfmakeraw()`, the discipline passes bytes through unprocessed — this is how full-screen programs (vim, htop, Claude Code's TUI) work.

Data flowing master→slave: keystrokes, encoded as raw bytes or escape sequences (`\x1b[A` for arrow-up). Data flowing slave→master: UTF-8 text interleaved with ANSI/xterm escape sequences. The core sequences: `CSI n;m H` (cursor position), `CSI n m` (SGR color/style), `CSI 2 J` (clear screen), `OSC` sequences (title, hyperlinks). The terminal emulator parses these and paints pixels.

### Why this is limiting

**No schema, no types, no versioning.** The protocol is implicit — accreted over decades with no coordination body. Feature detection relies on the `TERM` environment variable and terminfo databases. Each terminal invents its own extensions (Kitty graphics, iTerm2's OSC 1337, sixel) with fragile detection via query-and-timeout.

**Everything must serialize into one byte stream.** There's no out-of-band channel. Text, colors, cursor positioning, images, hyperlinks, clipboard access — all encoded as escape sequences interleaved with content. A program cannot send structured data alongside its output. A terminal emulator cannot ask "what kind of output is this?"

**Fixed-size kernel buffer** (typically 4096 bytes on macOS). Writes block when full. This creates backpressure that affects program behavior — fast output from `cat` of a large file stalls differently than slow output from a network tool.

**Terminal multiplexers (tmux, screen) are lowest-common-denominator filters.** They sit between shell and terminal, maintaining a virtual screen buffer for detach/reattach. But they must parse and re-emit escape sequences, which means advanced features (Kitty graphics, custom OSC sequences) don't pass through. Passthrough modes exist but are fragile.

**Modern extensions hit the ceiling.** Kitty's graphics protocol embeds raster images via escape sequences (base64-encoded or shared memory). Sixel encodes pixels inline. These prove the desire for rich output — but they're hacks built on a text-only transport. There's no layout model, no component system, no interactivity beyond "emit bytes and hope the terminal understands."

### What Claude Code already proved

Claude Code's `--output-format stream-json` mode bypasses the entire pty model. It communicates via **typed JSON events over stdio** — no escape sequences, no character grid, no terminal emulation. A graphical host spawns it as a child process, reads/writes its stdio, and renders its output with full fidelity.

The architectural lesson is not just that a structured protocol is *possible* — it's that it's *better*. Permission dialogs with allow/deny buttons. Tool use blocks showing name, input, output, and duration. Streaming text with delta accumulation. Cost tracking with per-turn token breakdowns. Subagent activity with nested tool calls. None of these would be possible through the pty. The terminal version of Claude Code works *despite* the terminal, not because of it. Tugtalk exists specifically to bridge Claude Code's structured protocol onto the terminal. Tide eliminates the need for that bridge — the structured protocol goes directly to a surface that can render it natively.

This is the template for Tide's shell side: instead of parsing a byte stream that flattens everything into characters, communicate via typed events and render with purpose-built components.

### What we keep, what we discard

| Layer | Status | Rationale |
|-------|--------|-----------|
| **Kernel pty** | Hidden — and often bypassed | bash/zsh check `isatty()` — they need a tty to run interactively. Tugshell holds the master fd internally. But for recognized commands, the adapter doesn't even read the pty output. The git adapter runs `git status --porcelain=v2` directly. The ls adapter calls `stat()` on directory entries. The pty exists to keep the shell happy and to capture output from *unrecognized* commands. For recognized commands, it's bypassed entirely. |
| **Line discipline** | Active (hidden) | Signal generation (Ctrl-C → SIGINT) works through the pty. We need this. |
| **ANSI SGR sequences** | Mapped to CSS | Bold, italic, underline, 256-color, true-color → mapped to CSS properties in the monospace fallback renderer. SGR is the one piece of the VT100 legacy that works well for our purposes — it's text style annotation, not hardware simulation. A large percentage of command output uses SGR and nothing else: `grep --color`, `git diff` with color, `cargo` warnings in yellow, errors in red. The fallback renderer that correctly maps SGR to CSS handles this output *better than most terminals render it*. The fallback is a genuine product, not a concession. |
| **VT100 cursor addressing** | Discarded | No `CSI n;m H`, no `CSI 2 J`. Programs that rely on cursor-addressable screens (vim, htop, less) are excluded from the unified surface — available via the separate terminal card. |
| **Terminal multiplexer** | Not needed | Tide's shell bridge (tugshell) holds the pty directly — no tmux/screen in the middle. This is simpler than the existing tugcast terminal path, which goes through tmux. No passthrough filtering, no lowest-common-denominator constraints. |
| **Escape sequence extensions** | Discarded | No Kitty graphics, no sixel, no OSC 1337. These are heroic engineering in service of a fundamentally wrong abstraction — encoding pixels as escape sequences injected into a text stream. Tide has a real graphics layer and doesn't need them. Their existence is evidence that the terminal community wants what we're building. |

---

## Core Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  TIDE — Graphical Surface                │
│                                                          │
│  ┌─────────────────────────────┐                         │
│  │    Unified Command Input    │                         │
│  │                             │                         │
│  │  > natural language → AI    │                         │
│  │  $ shell command → shell    │                         │
│  │  : surface command → tide   │                         │
│  └─────────────┬───────────────┘                         │
│                │                                         │
│  ┌─────────────▼───────────────┐                         │
│  │    Three-Tier Dispatch      │                         │
│  │                             │                         │
│  │  Surface built-in → handle  │                         │
│  │  Claude Code → tugcode      │                         │
│  │  Shell → tugshell           │                         │
│  └──┬──────────┬───────────────┘                         │
│     │          │                                         │
│  ┌──▼────┐  ┌──▼──────────────────┐                      │
│  │tugcode│  │tugshell             │                      │
│  │       │  │                     │                      │
│  │stream │  │hidden pty + hooks   │                      │
│  │json   │  │command adapters     │                      │
│  │over   │  │structured output    │                      │
│  │stdio  │  │                     │                      │
│  └──┬────┘  └──┬──────────────────┘                      │
│     │          │                                         │
│  ┌──▼────┐  ┌──▼──────────────────┐                      │
│  │Claude │  │bash / zsh           │                      │
│  │Code   │  │(unmodified)         │                      │
│  └───────┘  └─────────────────────┘                      │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              Unified Output Stream                  │ │
│  │                                                     │ │
│  │  ┌─ $ git status ───────────────────────────────┐   │ │
│  │  │  GitStatusBlock: branch main, 2 staged, ...  │   │ │
│  │  └──────────────────────────────────────────────┘   │ │
│  │  ┌─ > fix the build error in lib.rs ────────────┐   │ │
│  │  │  AssistantTextBlock: streaming markdown...   │   │ │
│  │  │  ToolUseBlock: Edit src/lib.rs               │   │ │
│  │  │  AssistantTextBlock: "Fixed the lifetime..." │   │ │
│  │  └──────────────────────────────────────────────┘   │ │
│  │  ┌─ $ cargo test ──────────────────────────────┐    │ │
│  │  │  BuildOutputBlock: 47 passed, 0 failed      │    │ │
│  │  └─────────────────────────────────────────────┘    │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

---

## Command Input: Prefix Routing

The unified command input uses a single-character prefix to route commands:

| Prefix | Route | Example |
|--------|-------|---------|
| `>` | Claude Code | `> which files need updating for the foo feature` |
| `$` | Shell | `$ git status` |
| `:` | Surface built-in | `:model sonnet` `:theme dark` `:cost` |

The prefix is clear, learnable, and type-ahead friendly. It mirrors conventions developers already know: `>` evokes a prompt/quote (natural language), `$` is the shell prompt, `:` is the vim command prefix.

Open design questions:
- Default when no prefix is typed? Context-dependent (last-used route) or require prefix always?
- Auto-detection as fallback? If text looks like a shell command, route to shell; if natural language, route to Claude Code.
- Can the prefix be implicit via UI context (e.g., a mode indicator or toggle)?

---

## Three-Tier Command Dispatch

Shells have used a tiered dispatch model for decades: built-in commands (`cd`, `export`) are handled by the shell itself without spawning a process; functions and aliases expand within the shell; external commands fork and exec a binary. This pattern is proven and well-understood. Tide adopts the same model with three tiers — surface built-ins, Claude Code pass-through, and shell pass-through.

The surface built-ins are the exact analog of shell built-ins. `cd` in bash doesn't spawn a process — it modifies the shell's own state. Tide's `:model` switcher doesn't talk to Claude Code or the shell — it modifies the surface's own state (and sends a `model_change` message as a side effect). The surface built-ins form a **stable layer that exists regardless of whether Claude Code or the shell is connected**. You can display cost, switch themes, manage sessions, and navigate history even if both backends are down. This is exactly how shell built-ins work — `cd`, `echo`, `export` all work even if PATH is empty and no external commands are available.

### Tier 1: Surface Built-Ins

Handled entirely by the graphical surface. Never reach shell or Claude Code. Modify surface state.

| Command | What It Does | Data Source |
|---------|-------------|-------------|
| `:model [name]` | Switch Claude Code model | Send `model_change` message |
| `:permission [mode]` | Switch permission mode | Send `permission_mode` message |
| `:cost` | Show cost/token display | Cached `cost_update` events |
| `:status` | Show session/model/context | Cached `system_metadata` |
| `:clear` | Start new session | Send `session_command: "new"` |
| `:theme [name]` | Switch visual theme | Surface state |
| `:session [cmd]` | Session management (list, resume, fork) | Filesystem + session state |
| `:export` | Export conversation | Accumulated event history |
| `:help` | Show help | Surface state |

These are the "UI Must Build" items from tug-conversation.md (U9-U11, C1-C15), reframed as surface built-ins.

### Tier 2: Claude Code Pass-Through

Routed to Claude Code via tugcode/tugcast stream-json protocol. Full event stream returns.

- Natural language prompts (`> fix the bug in...`)
- Slash commands (`> /plan`, `> /implement`, `> /compact`)
- All Claude Code interaction: streamed markdown, tool use, permissions, questions

The protocol is fully documented in [transport-exploration.md](transport-exploration.md). The rendering pipeline is designed in [tug-conversation.md](tug-conversation.md) Phases 3-7.

### Tier 3: Shell Pass-Through

Routed to bash/zsh via tugshell. Command adapters produce structured output.

- Any shell command (`$ git status`, `$ cargo build`, `$ ls -la`)
- Pipelines (`$ ls | grep foo | wc -l`)
- Shell built-ins (`$ cd src`, `$ export FOO=bar`)
- Aliases and functions from user's shell configuration

---

## The Shell Bridge: Tugshell

Tugshell is the analog of tugcode. Tugcode bridges Claude Code's stream-json to tugcast. Tugshell bridges bash/zsh to tugcast.

### Layer 1: Shell Process Management

- Spawns bash/zsh as login interactive (`zsh -li`) to load full user environment
- Hidden pty for OS compatibility — the shell requires a tty, but the pty never renders as a character grid
- Injects shell integration hooks via precmd/preexec (zsh) or PROMPT_COMMAND/DEBUG trap (bash)
- Uses OSC 133 markers to delimit command boundaries (same pattern as iTerm2, VS Code, Warp)

**What the hooks capture**:
- Full command line as typed (preexec `$1`)
- Exit code (`$?` in precmd, `$pipestatus` for pipelines)
- Duration (timestamp in preexec vs. precmd)
- Working directory before and after
- Raw stdout/stderr bytes from the hidden pty

### Layer 2: Command Adapter Registry

Maps `(command_name, args)` to an adapter function. The adapter receives the command context and produces a typed output event.

```
Adapter receives:
  - command: "git status"
  - args: ["status"]
  - raw_stdout: bytes from pty
  - exit_code: 0
  - cwd: "/src/tugtool"

Adapter produces:
  - format: "git_status"
  - data: { branch: "main", staged: [...], unstaged: [...], untracked: [...] }
```

Three adapter strategies:

| Strategy | When | Example |
|----------|------|---------|
| **Structured invocation** | Command has JSON/porcelain mode | Run `git status --porcelain=v2` instead of parsing pty output |
| **Output parsing** | Command has stable text format | Parse `ls -la` column output; parse unified diff format |
| **Raw passthrough** | Unknown command or unstable output | Emit format="text" with raw stdout |

Some adapters bypass the pty entirely. The git adapter can run `git status --porcelain=v2` directly and produce structured data without ever looking at what the pty captured. The pty output is a fallback, not the primary source.

**Design principle: prefer structured invocation over pty parsing.** Parsing pty output is fragile — column positions shift between versions, ANSI color codes confuse parsers, locale settings change number and date formatting, and wide characters break column alignment. Structured invocation is reliable: JSON is JSON, porcelain format is a stable contract. Where a command offers a machine-readable output mode, the adapter should use it rather than parsing the human-readable output. The user typed `git status`; the adapter fulfills that *intent* by running `git status --porcelain=v2`. The raw command is the intent; the adapter chooses the best means to produce structured data from it.

**Fallback behavior**: Unknown commands get their stdout rendered as styled monospace text. Simple ANSI SGR sequences (bold, colors) are mapped to CSS styles. No VT100 cursor addressing, no character grid, no terminal emulation. Expandable and revisable as we learn.

### Layer 3: Protocol Events

Shell events follow the same pattern as Claude Code events — typed JSON over tugcast's WebSocket:

```json
{ "type": "command_start", "id": "cmd-42", "command": "git status",
  "cwd": "/src/tugtool", "timestamp": "2026-04-02T10:30:00Z" }

{ "type": "command_output", "id": "cmd-42", "format": "git_status",
  "data": { "branch": "main", "staged": [...], "unstaged": [...] } }

{ "type": "command_complete", "id": "cmd-42", "exit_code": 0,
  "duration_ms": 45, "pipestatus": [0] }
```

For pipelines:
```json
{ "type": "command_start", "id": "cmd-43", "command": "ls | grep foo",
  "pipeline": ["ls", "grep foo"], "cwd": "/src/tugtool" }

{ "type": "command_output", "id": "cmd-43", "format": "text",
  "data": { "text": "foo.rs\nfoobar.txt\n" } }

{ "type": "command_complete", "id": "cmd-43", "exit_code": 0,
  "pipestatus": [0, 0] }
```

For redirections:
```json
{ "type": "command_start", "id": "cmd-44", "command": "cargo build > build.log 2>&1",
  "redirects": [{ "fd": 1, "target": "build.log" }, { "fd": 2, "target": "&1" }] }

{ "type": "command_output", "id": "cmd-44", "format": "redirect_notice",
  "data": { "message": "Output written to build.log", "path": "build.log" } }

{ "type": "command_complete", "id": "cmd-44", "exit_code": 0 }
```

---

## Command Adapters: Priority List

Based on usage frequency analysis. ~20 adapters cover 80%+ of developer shell usage.

### Tier A — Native Structured Output (highest value, lowest effort)

| Command | Structured Source | Graphical Rendering |
|---------|------------------|-------------------|
| `git status` | `--porcelain=v2` | Staged/unstaged file lists with status icons, action buttons |
| `git log` | `--format=<json-ish>` | Commit timeline with clickable hashes, author avatars, branch refs |
| `git diff` | Unified diff format (stable) | Side-by-side diff viewer with syntax highlighting |
| `docker ps` | `--format '{{json .}}'` | Sortable container table with status badges |
| `docker images` | `--format '{{json .}}'` | Image table with size, age, tags |
| `npm ls` / `yarn list` | `--json` | Interactive dependency tree with version badges |
| `cargo build` | `--message-format=json` | Build output with clickable error locations, warning counts |
| `cargo test` | `--message-format=json` | Test results with pass/fail/skip counts, failure details |
| `kubectl get` | `-o json` | Resource tables with status indicators |
| `brew info` | `--json=v2` | Package info cards |
| `aws` (all) | JSON by default | Structured response viewer |
| `curl` | `-w '%{json}'` for metadata | Response viewer with headers, formatted body |

### Tier B — Stable Parseable Output (moderate effort)

| Command | Parsing Strategy | Graphical Rendering |
|---------|-----------------|-------------------|
| `ls` / `eza` | Direct filesystem stat (bypass pty) | Icon-rich file grid with metadata columns, sorting, thumbnails |
| `grep` / `rg` | `rg --json` or parse match format | Grouped results with highlighted matches, clickable file:line |
| `find` / `fd` | One path per line | File tree or flat list with icons |
| `ps` | `-o` custom format | Process table, sortable |
| `diff` | Unified diff format | Side-by-side viewer |
| `du` / `df` | Columnar output, stable | Treemap or bar chart visualization |
| `wc` | Numeric columns | Formatted count display |
| `env` / `export` | KEY=VALUE per line | Searchable/filterable variable table |

### Tier C — Monospace Fallback (no adapter needed)

`make`, `echo`, `python`, `cat`, `head`/`tail`, `chmod`, `mkdir`, `rm`, `cp`/`mv`, `tar`, `swift`/`swiftc`

Rendered as styled monospace text blocks. ANSI SGR colors (bold, red, green, etc.) mapped to CSS. No VT100 emulation.

### Tier D — Terminal Card Only (excluded from unified surface)

`vim`/`nvim`, `htop`/`top`, `less`/`more`, `ssh`, `tmux`

Available via the separate terminal card in tugdeck. Not part of Tide's unified surface.

---

## Tugcast: The Multiplexer

### One pipe, one multiplexer, many backends

There is one WebSocket connection between tugdeck and tugcast. Every frame, in both directions, flows over that single connection. FeedIds are routing labels inside the pipe — not separate connections. This is the same pattern as HTTP/2 streams over a single TCP connection.

```
                    ONE WebSocket (bidirectional)
                    ════════════════════════════
tugdeck ◄──────────────────────────────────────────────► tugcast
                    
        Outbound frames (tugdeck → tugcast):
          [0x41] CodeInput  → routed to tugcode
          [0x61] ShellInput → routed to tugshell
          
        Inbound frames (tugcast → tugdeck):
          [0x40] CodeOutput  ← from tugcode
          [0x60] ShellOutput ← from tugshell
          [0x10] Filesystem  ← from file watcher
          [0x20] Git         ← from git watcher
          [0x30] Stats       ← from stats collector
          [0x50] Defaults    ← from tugbank
          [0x70] TugFeed     ← from feed capture
          [0xFF] Heartbeat   ← from tugcast
```

Tugcast is the single point of contact for tugdeck. Behind it, tugcast manages N backend processes. Each backend is a **bridge** — a process that speaks a service-specific protocol on one side and emits/receives typed JSON events via tugcast on the other. Bridges have independent lifecycles and failure modes: if Claude Code crashes, the shell keeps working; if the shell hangs, Claude Code still responds.

### Bridge naming convention

Each bridge is named `tug{suffix}` where the suffix identifies the service it bridges to. The bridge speaks the service's native protocol on one side and emits/receives typed JSON events via tugcast on the other.

| Bridge | Service | Protocol | FeedIds |
|--------|---------|----------|---------|
| **tugcode** (currently tugtalk — rename in Phase T0) | Claude Code | stream-json over stdio | 0x40/0x41 |
| **tugshell** | bash/zsh | hidden pty + shell hooks | 0x60/0x61 |
| *(future)* | Another LLM, service, or tool | TBD | next available pair |

### Feed ID table

| FeedId | Feed | Direction | Backend | Status |
|--------|------|-----------|---------|--------|
| 0x00 | TerminalOutput | server → client | tmux (terminal card) | Existing |
| 0x10 | Filesystem | server → client | file watcher | Existing |
| 0x20 | Git | server → client | git watcher | Existing |
| 0x30-0x33 | Stats | server → client | stats collector | Existing |
| 0x40 | CodeOutput | server → client | tugcode | Existing |
| 0x41 | CodeInput | client → server | tugcode | Existing |
| 0x50 | Defaults | server → client | tugbank | Existing |
| **0x60** | **ShellOutput** | **server → client** | **tugshell** | **New** |
| **0x61** | **ShellInput** | **client → server** | **tugshell** | **New** |
| 0x70 | TugFeed | server → client | feed capture | Planned |

### Extensibility

The FeedId namespace is an open byte range (0x00-0xFF). Adding a new backend service means:

1. Write a `tug{service}` bridge process that speaks the service's protocol and emits typed JSON events
2. Assign the next available FeedId pair
3. Register in tugcast's router
4. Tugdeck starts rendering events from the new FeedId — using existing block components or new ones if the service has unique event types

Nothing else changes. No tugcast refactoring, no protocol changes, no tugdeck rewiring. This is what makes the architecture flexible enough to accommodate a new LLM provider (Gemini, a future model), a new developer tool, or a service that doesn't exist today. The protocol contract — binary framing with FeedId routing, typed JSON payloads — is the stable layer. What's behind each FeedId can change independently.

**Critical design constraint:** Tugcast must route opaquely. It forwards frames by FeedId without interpreting the JSON payloads. Event type semantics live in tugdeck and the bridge processes, not in the multiplexer. If tugcast needs to understand payload contents to route correctly, the abstraction is leaking.

---

## Environment Model

### Working Directory

The shell's cwd is the source of truth. When the user types `$ cd src`, the shell's cwd changes. The surface updates its cwd display. The next Claude Code turn inherits the new cwd.

### Variables and Export

The shell bridge runs a real shell. `export FOO=bar` works as expected. Tools that depend on environment mutation — direnv, nvm, conda, pyenv, homebrew — work because the real shell process manages the environment.

### Aliases and Functions

Loaded from the user's startup files. `alias gst='git status'`, user-defined functions — all work because the real shell executes them. The adapter registry recognizes the resolved command (after alias expansion), not the alias itself.

### Startup Files

Full sequence honored via login interactive launch:
- zsh: `/etc/zshenv` → `~/.zshenv` → `~/.zprofile` → `~/.zshrc`
- bash: `~/.bash_profile` (which typically sources `~/.bashrc`)

### Claude Code Environment Sync

The shell and Claude Code environments are **parallel but synchronized** — not unified. They are separate OS processes, each with their own environment, and they can't share memory. The surface keeps them in sync: shell `cd` → surface updates its cwd → Claude Code's next turn inherits the new cwd. Environment variables exported in the shell are available to Claude Code's Bash tool calls (tugshell can snapshot the current environment and pass it through). This is the pragmatic model — full fidelity for each process, with the surface as the synchronization point.

---

## Design Laws

### Existing Tuglaws (apply to Tide)

All existing Tuglaws apply to Tide's rendering. L01 (one render), L02 (useSyncExternalStore), L06 (CSS/DOM for appearance), etc.

### Proposed New Law

> **[Lxx] The pty is opaque.** The graphical surface never exposes terminal emulation artifacts to the user. No VT100 character grids, no ANSI cursor addressing, no escape-sequence-driven screen painting. A hidden pty may exist as OS-level plumbing for shell compatibility, but its byte stream is consumed by adapters that produce typed, structured output. If a program's output cannot be meaningfully adapted, it renders as styled monospace text — not as a terminal emulator viewport. The terminal card is a separate, explicit opt-in outside the unified surface.

### Shell UX Laws (must not violate)

These conventions are so deeply ingrained that violating them would make the surface unusable:

1. **Ctrl-C always interrupts.** Maps to both shell SIGINT and Claude Code `interrupt`.
2. **The prompt means "ready for input."** The command input must show a clear readiness signal.
3. **Commands are text.** Users paste commands from docs and Stack Overflow. The input must accept raw pasted text.
4. **The environment is sacred.** PATH, HOME, direnv mutations, nvm, conda — all must work.
5. **Output is a stream.** Even though we render richly, raw text must remain accessible for copy-paste.
6. **Failure is normal.** Non-zero exit codes are information, not errors to hide.

---

## Research Findings

These findings are from five research threads conducted during the initial Tide design conversation. They are the evidence base for the design decisions above. The Research Agenda (later in this document) tracks what still needs to be verified in practice.

### Shell integration hooks

**zsh** provides `preexec(command, fullcommand, fullcommand_expanded)` — called before each command execution. The three arguments give: the command collapsed to one line, the full multi-line text, and the alias-expanded version. For `ls | grep foo`, you get the literal string `"ls | grep foo"`. There is no parsed argv array. `precmd()` fires after the command completes — `$?` holds the exit code, `$PWD` is the current directory. `chpwd()` fires on directory changes. `$pipestatus` gives per-stage exit codes for pipelines.

**bash** provides the `DEBUG` trap, which fires before **every simple command** in a pipeline — more granular than zsh's `preexec` but noisier, requiring deduplication logic. `$BASH_COMMAND` contains the current simple command text. `PROMPT_COMMAND` fires after completion (equivalent to `precmd`). Bash does **not** provide alias-expanded text.

**OSC 133 markers** are the industry-standard technique for delimiting command boundaries. iTerm2, Warp, and VS Code terminal all use the same protocol: `OSC 133;A` (prompt start), `OSC 133;B` (command start), `OSC 133;C` (output start), `OSC 133;D;{exit_code}` (command finished). The shell integration scripts inject these via `precmd`/`preexec` hooks. This is a solved, battle-tested pattern.

**What we get reliably:** full command line as typed, exit code (including per-stage via `pipestatus`), duration (timestamp in `preexec` vs. `precmd`), working directory before and after.

**What we don't get:** a parsed AST. Detecting pipes, redirections, and subshells requires parsing the command string ourselves. This is doable for common cases (splitting on `|`, detecting `>`, `2>&1`) and gets fragile at the edges (heredocs, nested quoting, multi-line commands). The pragmatic path: parse what we can, fall back gracefully when we can't.

**Zsh's `preexec` is cleaner for our model** than bash's DEBUG trap — one call per command line rather than one per pipeline stage. Zsh is the default shell on macOS, which is our primary target.

### Command coverage

Data from published shell history analyses (~250K histories from commands.dev, multiple GitHub repos analyzing `.bash_history`/`.zsh_history`):

- **git alone is 15-25% of all commands.** Git has excellent structured output: `--porcelain`, `--format=<custom>`, and JSON-compatible formats for many subcommands. This is the highest-value adapter by far.
- **Top 10 commands** (git, cd, ls, cat, grep, docker, npm/yarn, cargo, make, vim) cover roughly **55-65% of usage**.
- **~19-22 commands** with structured adapters would cover **80%+ of developer shell interactions**.

The commands break into categories that directly map to adapter strategy:

| Category | Commands | Adapter Strategy |
|----------|----------|-----------------|
| **A: Native JSON** | git (some), docker, npm, cargo, kubectl, brew, aws, terraform, curl | Pass `--json` or equivalent. Lowest effort, highest fidelity. |
| **B: Stable parseable** | git (porcelain), ls, grep/rg, find, ps, diff, wc, du/df | Parse well-known text formats, or bypass the pty entirely (ls adapter calls `stat()` directly). |
| **C: No output** | cd, rm, cp, mv, mkdir, chmod | Show status confirmation. No output to parse. |
| **D: Free-form text** | make, echo, python, cat, tail/head | Styled monospace fallback with SGR→CSS mapping. |
| **E: Full-screen** | vim, htop, less, top, ssh | Excluded from unified surface. Terminal card only. |

**Key insight:** We don't need to parse VT100 output for any of these. For A, we ask for JSON. For B, we parse stable text or bypass the pty. For C, there's nothing to parse. For D, we render the text with color. For E, we punt to the terminal card.

**Parsing libraries (all MIT/Apache-2.0):** `serde_json` (JSON), `git2` (git structured access), `nom` (custom parsers), `csv` (columnar text), `strip-ansi-escapes` (ANSI removal), `tree-sitter` (syntax highlighting).

### Structured shell precedents

Four systems were studied. Each makes a different tradeoff at the external-command boundary — the seam where structured internal data meets unstructured external program output. Understanding these tradeoffs is what makes Tide's approach defensible.

**Nushell** (MIT): The purest model. Every command returns typed data (`Value` enum: Bool, Int, String, Record, List, etc.). Tables are `List<Record>`. Pipelines pass structured data end-to-end. But external commands produce `ByteStream` — raw bytes with no structure. The user must explicitly convert: `^git status | lines` or `^curl url | from json`. No auto-detection. The boundary is clean but requires user action. *Lesson: the explicit `from`/`to` boundary is principled but creates friction.*

**PowerShell** (MIT): Object pipeline internally. Cmdlets emit .NET objects. `Get-Process` returns `Process[]`. The formatter picks a view based on the object type — `Format-Table`, `Format-List`, `Format-Wide` — selected via declarative `.ps1xml` definitions keyed by type name. But external commands produce `[string]` — one per line, no structure. Same explicit boundary as Nushell. *Lesson: the type-to-default-view mapping is directly relevant to our renderer dispatch. If our system knows a command returns "git status" data, it selects the right renderer without user action.*

**Jupyter** (BSD-3-Clause): The multi-representation pattern. A single `display_data` message carries a dict of representations: `{"text/plain": "...", "text/html": "<table>...", "image/png": "base64...", "application/json": {...}}`. The frontend picks the richest format it can render. *Lesson: this is the strongest design pattern for our output model. Command output as a bundle of typed representations lets different consumers pick the best format.*

**Warp** (proprietary — concepts only, no code): Block model where each command is a discrete object with metadata (command text, exit code, timing, cwd). Shell integration scripts inject OSC 133 escape sequences around boundaries. AI agent operates on blocks — it can see structured command history, not just a text buffer. *Lesson: proves command-as-object works commercially. The OSC 133 pattern is standard.*

**The gap nobody fills:** Every system treats external commands as opaque text at the boundary. Nushell requires `from json`. PowerShell requires `ConvertFrom-Json`. Jupyter requires the kernel to produce structured output. None auto-detect known external command output and produce structured data from it. Tide's adapter registry is the first to bridge this gap — recognizing `git status` and producing structured data automatically.

### Pipe and redirection semantics

**The hybrid approach:** Run full pipelines natively through the hidden pty. Don't intercept intermediate stages. Parse the command string from `preexec` to understand the pipeline topology — what commands are involved, what the user was trying to do. Render the final output with knowledge of the full pipeline.

This preserves full Unix compatibility. Every existing pipeline works. But recognized patterns get progressive enhancement — `git log | head` can be recognized as "git log output, truncated" and rendered as a commit timeline with a note.

**For redirections** (`> file.txt`, `2>&1`), detect by parsing the command string. When stdout is redirected to a file, show an annotation ("Output written to file.txt" with a link) rather than rendering nothing.

**`pipestatus`/`PIPESTATUS`** gives per-stage exit codes. On pipeline failure, show which stage failed — e.g., "grep exited 1" in a `find | grep | wc` pipeline.

**Subshells and command substitution** (`$(command)`, `(cmd1; cmd2)`) are handled transparently by the real shell. The graphical surface doesn't need to understand them — let the shell resolve them.

**The Nushell contrast:** Nushell's structured pipeline is more powerful (structured data flows between stages) but breaks compatibility — native Unix commands need wrappers. Tide's approach is the opposite: full compatibility first, progressive richness on top. A user can paste any command from Stack Overflow and it works.

### Shell concepts from decades of development

**Startup file sequence** matters for correctness. Zsh loads: `/etc/zshenv` → `~/.zshenv` → `~/.zprofile` → `~/.zshrc` (for login interactive). Bash loads: `~/.bash_profile` (which typically sources `~/.bashrc`). Users put PATH modifications in `.zprofile`/`.bash_profile` and aliases/functions in `.zshrc`/`.bashrc`. If the shell bridge doesn't source the right files, users' environments are broken. The safest approach: launch as login interactive (`zsh -li`).

**The alias→function→builtin→external lookup order** is how the shell resolves commands. Aliases are text substitution at parse time. Functions are proper callable units with arguments and local variables. Builtins (`cd`, `export`, `source`) must run in the shell process because they modify its state. External commands are looked up via `$PATH`. The adapter registry operates after alias expansion (using `preexec`'s third argument in zsh) to see the resolved command, not the alias.

**The completion system is an untapped treasure.** Zsh's compsys and bash-completion contain machine-readable descriptions of command interfaces — argument types, subcommands, flags, file-type filters, dynamic completions (like git branch names from the repo). These specs describe what a command *accepts*. A graphical surface could use them for contextual help, argument suggestions, or structured input forms. This is richer than Fig/Amazon Q CLI specs (MIT) and it's already installed on every developer's machine.

**Job control** manages foreground/background process groups. Ctrl-Z sends SIGTSTP; `fg`/`bg` resume. The `jobs` list is state users expect to see. A graphical surface could make this *visible* — showing running/stopped jobs as tiles or tabs — which would be a genuine improvement over the invisible jobs list in traditional shells.

**History** is append-to-file (`~/.zsh_history`), searchable via Ctrl-R, with expansion (`!!` = last command, `!$` = last argument, `^old^new` = quick substitution). Zsh supports shared history across sessions and timestamped entries. Ctrl-R search is non-negotiable muscle memory. `!!` and `!$` are deeply ingrained. Per-directory history would be a graphical surface win that traditional shells struggle to provide.

**Line editing keybindings** that must be replicated: Ctrl-A/E (home/end), Ctrl-W (delete word back), Alt-B/F (word movement), Ctrl-R (history search), Ctrl-C (interrupt). These ~15 bindings cover 99% of users. The graphical input can be richer than readline (multi-line, rich text, inline suggestions) but must not break these keybindings.

**Parameter expansion** (`${var:-default}`, `${var##*/}`, `${var%.*}`) is heavily used in scripts but rarely typed interactively beyond `$VAR`. This is a scripting concern, not an interactive one — the graphical surface doesn't need to handle it specially.

---

## Phases

Tide builds on completed foundation work (Phases 1-3A.7) documented in [tug-conversation.md](tug-conversation.md). This section is the authoritative forward-looking roadmap — it integrates the Claude Code UI work (formerly Phases 3B-7) with the shell and unified surface work.

```
─── FOUNDATION (DONE) ─────────────────────────────────────
Phase 1: Transport Exploration           — DONE (35 tests)
Phase 2: Transport Hardening             — DONE (T1-T7)
Phase 2b: WebSocket Verification         — DONE (4 issues found, all fixed)
Phase 2c: WebSocket Fixes                — DONE (T8-T11)
Phase 3A: Markdown Rendering Core        — DONE
Phase 3A.1-3A.4: Worker/WASM Pipeline    — DONE
Phase 3A.5: Region Model + API           — DONE
Phase 3A.6: SmartScroll                  — DONE
Phase 3A.7: SmartScroll Hardening        — DONE

─── TIDE: FOUNDATION ──────────────────────────────────────
Phase T0: Naming Cleanup                 — rename binaries, crates, directories for Tide
Phase T0.5: Protocol Hardening           — open FeedId, dynamic router, lag recovery, extensibility
  P2: Dynamic router                       — **LANDED (2026-04-12). Unblocks T3.4 multi-session.**
                                             Approved approach: keep CODE_OUTPUT (0x40) / CODE_INPUT (0x41)
                                             as single FeedId slots, encode session_id in each frame's
                                             payload, demux in the router, filter client-side. Enables
                                             Tide card ↔ CodeSessionStore 1:1 per D-T3-09.
  P2 follow-up: golden catalog             — **LANDED (2026-04-13). Baseline v2.1.105, drift test passing.**
                                             Machine-readable golden fixtures + hand-rolled shape differ
                                             + drift regression test for the Claude Code stream-json
                                             catalog (Layer A). Safety net for T3.4.a: if Anthropic ships
                                             a new Claude version with different event shapes, the drift
                                             test fails loudly instead of CodeSessionStore silently
                                             corrupting its turn state. See #p2-followup-golden-catalog.
  P13: Spawn cap + rate limit              — concurrent-session hard cap + leaky-bucket spawn rate in
                                             AgentSupervisorConfig. Lands opportunistically after T3.4.a
                                             as cheap insurance before real users touch Tide.
  P14: Claude Code --resume                — persist claude_session_id alongside tug_session_id so cards
                                             survive reload with history intact. Explicitly overturns
                                             tugplan-multi-session-router §[D12]'s "reload = fresh" call.
                                             Lands after T3.4.a so UI feedback shapes the reset vs resume
                                             semantics per card.
  P15: Version gate + divergence telemetry — runtime version capture, structured stream_json_divergence
                                             events on a new SUPERVISOR_TELEMETRY (0x53) broadcast feed,
                                             and a version-adaptive reducer scaffold in CodeSessionStore.
                                             Builds on P2 follow-up's golden catalog. Lands after T3.4.a
                                             so the reducer's version-branching is informed by what
                                             CodeSessionStore actually consumes.
  P16: session_command routing bug (HIGH)  — session_command new/continue/fork probes (test-13/17/20)
                                             stall or misroute on the multi-session router. Surfaced
                                             during golden-catalog Step 4 canary; the three probes are
                                             currently skipped in v2.1.104/ + v2.1.105/ manifests with
                                             §T0.5 P16 pointers. **Blocks T3.4.d multi-session.** Can
                                             run in parallel with T3.4.a/b/c (which are single-session).
                                             Needs root-cause investigation in tugcode/supervisor before
                                             re-enabling the three probes in the probe table.
  P17: model_change prose reshape (INFO)   — **RESOLVED during golden-catalog Step 4/5.** Prose catalog
                                             described a synthetic assistant_text confirmation that did
                                             not survive against live claude 2.1.104. The Step-2 round-trip
                                             test was reshaped to a behavioral assertion; the "Known
                                             divergences" section in dash/transport-exploration.md
                                             records the delta. No separate landing needed.
  P19: 45s WebSocket reset (RESOLVED)      — root cause: tugcast router enforces a 45 s application-
                                             level heartbeat (`router.rs::HEARTBEAT_TIMEOUT`). It sends
                                             a `FeedId::HEARTBEAT` frame every 15 s and expects the
                                             client to send one back; if no client heartbeat arrives
                                             within 45 s, the router calls `teardown_client` and drops
                                             the socket without a close frame. tugdeck's `connection.ts`
                                             implements the client side correctly. `TestWs` in
                                             `tests/common/mod.rs` did not, so every capture probe whose
                                             collect phase ran past 45 s hit `teardown_client` at the
                                             next heartbeat tick. Fixed by splitting `WsStream` and
                                             spawning a background heartbeat task in `TestWs::connect`
                                             that sends a heartbeat every 15 s for the lifetime of the
                                             socket. Regression guard:
                                             `test_heartbeat_survives_long_turn` in
                                             `multi_session_real_claude.rs` (asks for 300 words, turn
                                             runs ~51 s, asserts clean turn_complete). test-10
                                             un-skipped. test-25 and test-35 surfaced distinct non-P19
                                             issues (probe-script incomplete; first-run flake at
                                             stability>=2) and were re-skipped with new reasons as
                                             follow-on work. test-13/17/20 still skipped on P16.
                                             No tugcast or tokio-tungstenite change — the 45 s ceiling
                                             itself is correct dead-client detection.
  P20: rate_limit_event routing (MEDIUM)   — claude 2.1.105 emits `rate_limit_event` as a top-level
                                             stream-json sidecar on most turns; tugcode's
                                             routeTopLevelEvent has no handler, so the event is dropped
                                             before reaching CODE_OUTPUT and CodeSessionStore never sees
                                             it. Same class as the api_retry drop from transport-
                                             exploration.md. Pair with rate-limit UI work whenever that
                                             lands — no hard dependency on T3.4 phases.

─── TIDE: INPUT ───────────────────────────────────────────
Phase T3: Prefix Router + Prompt Input   — text model spike, atoms, completions, routing, history, turn state, live surface
  T3.0: Text Model Spike                   — DONE — contentEditable as input surface + own document model
  T3.1: tug-atom                           — DONE — inline token component (atoms as <img>)
  T3.2: tug-prompt-input                   — DONE — rich input with atoms, route atoms, @/ completions, maximize, persistence
  T3.3: Stores                             — DONE (modulo IndexedDB→tugbank rewrite of PromptHistoryStore per D-T3-10)
  T3.0.W: Workspace Registry Refactor      — multi-workspace tugcast; prerequisite for T3.4.a
    T3.0.W1: WorkspaceRegistry                — new registry, one-shot bootstrap, workspace_key splicing on FILETREE/FILESYSTEM/GIT
    T3.0.W2: Per-session workspace binding    — project_dir on spawn_session, ChildSpawner::spawn_child takes project_dir, LedgerEntry.workspace_key
    T3.0.W3.a: CLI + config cleanup           — rename --dir → --source-tree, new resources::source_tree() helper, gate dev-only code; keeps bootstrap alive
    T3.0.W3.b: Retire bootstrap workspace     — delete --source-tree flag + bootstrap entirely. **Rides with T3.4.c.**
  T3.4: Tide Card                          — prompt-entry + CodeSessionStore (turn state) + live Tide card
    T3.4.a: CodeSessionStore                 — per-card L02 store observing CODE_OUTPUT (filtered by tug_session_id); owns turn state machine + send/interrupt/approve; sessionKey is purely a human display label
    T3.4.b: tug-prompt-entry                 — compose input + route indicator + submit/stop driven by CodeSessionStore
    T3.4.c: Tide card                        — registered card, TugSplitPane (markdown-view top, prompt-entry bottom), one CodeSessionStore per instance, project_dir chosen at card mount
    T3.4.d: Polish & exit                    — end-to-end CODE_INPUT round-trip, CJK, a11y, Cmd+K focus, persistence
  [T3.5 folded into T3.4 — the Tide card is the integration surface, not a separate polish phase]

─── TIDE: RENDERING ───────────────────────────────────────
Phase T1: Content Block Types            — markdown, code, thinking, tool use, monospace

─── TIDE: SHELL INTEGRATION ───────────────────────────────
Phase T4: Shell Bridge (tugshell)        — spawn shell, hooks, command capture
Phase T2: Shell Command Blocks           — git, cargo, file listing, build output renderers
Phase T5: Adapter Registry + Fallback    — command routing, ANSI→CSS, monospace fallback
Phase T6: Core Adapters (Tier A)         — git, cargo, docker, npm adapters
Phase T7: Filesystem Adapters (Tier B)   — ls, grep, find, cat adapters
Phase T8: Pipe & Redirect Support        — pipeline parsing, pipestatus, redirect notices

─── TIDE: CONVERSATION ────────────────────────────────────
Phase T9: Conversation Wiring            — Claude Code round-trip, permissions, questions, interrupt
Phase T10: Surface Built-Ins             — :model, :cost, :status, :theme, :session, :help
Phase T11: Session & Advanced            — session picker/fork/resume, images, /btw, permissions reset

─── TIDE: UNIFICATION ─────────────────────────────────────
Phase T12: Environment Sync              — cwd, env vars shared between shell and Claude Code
Phase T13: Cross-Surface Interactions    — shell↔Claude context sharing, error assistance

─── FEED LAYER (from tug-feed.md) ─────────────────────────
Phase F1: Hook Capture                   — agent lifecycle events to feed.jsonl
Phase F2: Feed Correlation               — semantic enrichment with step context
Phase F3: Feed CLI + Tugcast             — tugcode feed commands, events reach browser
Phase F4: Agent-Internal Events          — file/command detail from within agents
Phase F5: Custom Block Renderers         — rich UI for agent output
```

---

### Execution Order: Close W2 → Tide Card {#execution-order-w2-to-tide}

The `T0.5` / `T3.0.W` / `T3.4` phases above resolve to the exact sequence below. Every item lists its direct dependency and any hard gate that must pass before the next step starts. Each entry links to its detail section elsewhere in this document — click through for scope, work items, and exit criteria.

**Rationale:** after W2 landed, the W2 plan's Step 8 manual smoke test ("open a card pointed at project A, open a second card pointed at project B, verify distinct feeds") turned out to require UI affordances that don't exist yet — the Tide card with its project-dir picker is T3.4.c. The sequence below threads that needle: it keeps every intermediate commit in a fully-working state and lands the manual smoke exactly when the UI makes it executable.

**1. Close [T3.0.W2](#t3-workspace-registry-w2)** — Run the automated Step 8 checkpoints (`cargo nextest`, `bun test`, grep verifications); they're all green today. Mark Step 8 complete with a roadmap note that the manual A/B smoke defers to [T3.4.c](#t3-4-c-tide-card). Vet `#deliverables` and `#exit-criteria` in `dash/tugplan-workspace-registry-w2.md`; check off what's met; note the manual criterion as "deferred to T3.4.c."
  - **Gate:** cleanup only.
  - **Blocks:** T3.0.W3.a.

**2. [T3.0.W3.a](#t3-workspace-registry-w3a) — CLI rename + config cleanup (bootstrap kept alive)** — Rename `--dir` to `--source-tree` across tugcast CLI, `main.rs`, Tug.app AppDelegate, docs. Introduce `resources::source_tree()` helper and route `resolve_tugcode_path`, `server.rs`'s `dist_path` computation, and the dev-only `BuildStatusCollector` / legacy settings migration / `.ts` tugcode fallback through it with `#[cfg(debug_assertions)]` gating. **Keep the W1 bootstrap `registry.get_or_create(&watch_dir, cancel.clone())` call in `main.rs`** so daily development against Tug.app still shows git/filetree content while T3.4.a–c are in flight.
  - **Gate:** W2 closed.
  - **Blocks:** T3.4.a.

**3. [T3.4.a](#t3-4-a-code-session-store) — CodeSessionStore** — Per-card L02 store observing `CODE_OUTPUT` via the `FeedStore` filter API (`tug_session_id` match). Owns the turn state machine: idle / thinking / tool-use / waiting-approval / complete / errored. Exposes `send` / `interrupt` / `approve` methods that encode outbound `CONTROL` / `CODE_INPUT` frames. Consumes `tests/fixtures/stream-json-catalog/v2.1.105/` as ground truth for reducer branches. Single-session per store instance (no `session_command new/continue/fork` — that's [P16](#p16-session-command-continue), deferred and non-blocking).
  - **Gate:** W3.a landed.
  - **Blocks:** P13, T3.4.b.

**4. [P13](#p13-spawn-cap) — Spawn cap + leaky-bucket rate limit** — `AgentSupervisorConfig::max_concurrent_sessions` (default 8), `max_spawns_per_minute` (default 20). Check at the top of `spawn_session_worker` before any channel allocation. `ControlError::CapExceeded` variant; `SESSION_STATE = errored { detail: "concurrent_session_cap_exceeded" | "spawn_rate_limited" }`. Interleaves here as cheap insurance before T3.4.b/c produce real UI load.
  - **Gate:** T3.4.a landed.
  - **Blocks:** T3.4.b (advisable, not structural).

**5. [T3.4.b](#t3-4-b-prompt-entry) — tug-prompt-entry** — New tugways component: compose input + route indicator + submit/stop button. Submit drives `codeSessionStore.send(...)`; stop drives `.interrupt()`; route indicator reads turn state. Built and tested in the gallery card against a mock `CodeSessionStore`; no running backend required for unit tests.
  - **Gate:** T3.4.a landed; P13 recommended first.
  - **Blocks:** T3.4.c.

**6. [T3.4.c](#t3-4-c-tide-card) — Tide card + [T3.0.W3.b](#t3-workspace-registry-w3b) bootstrap removal** *(ship together)* — Register the Tide card: `TugSplitPane` with `TugMarkdownView` (top) and `TugPromptEntry` (bottom), one `CodeSessionStore` per instance, `project_dir` chosen at card mount via a UI affordance (file picker / recent projects / "open this repo" button). On mount, send `spawn_session(cardId, tugSessionId, projectDir)` → wait for `spawn_session_ok` ack → `cardSessionBindingStore.setBinding` (already wired in W2 Step 7). On unmount, `sendCloseSession(...)` clears binding (already wired in W2 Step 7). **Rides with T3.0.W3.b**: delete the `--source-tree` CLI flag, delete the `registry.get_or_create(&watch_dir, cancel.clone())` bootstrap call, drop `server.rs::source_tree` parameter threading, unwire bootstrap-related router plumbing (`bootstrap.fs_watch_rx` etc.). **The manual A/B smoke from W2's Step 8 becomes executable here** — this is the first point where you can open a card pointed at project A, open a second card pointed at project B, and verify distinct workspace_key filters end-to-end.
  - **Gate:** T3.4.b landed.
  - **Blocks:** P14, P15, T3.4.d multi-session work.

**7. [P14](#p14-claude-resume) — Claude Code `--resume` for persistent session history** — Persist `claude_session_id` alongside `tug_session_id`. The `SessionKeyRecord.claude_session_id: Option<String>` field **already exists** — W2 Step 1 reserved it explicitly for P14, so no schema bump is required. Extend `run_session_bridge`'s `session_init` handler to persist the id via `SessionKeysStore`; `TugcodeSpawner` appends `--resume <id>` when the ledger entry has one; `rebind_from_tugbank` reads it back into the reconstructed `LedgerEntry`. UI: Tide card's "reset vs resume" semantics are informed by real-user feedback at T3.4.c — explicit reset starts fresh, default behavior resumes.
  - **Gate:** T3.4.c landed; UX on Tide card informs the semantics.
  - **Blocks:** first external users (closing the laptop and reopening must not lose conversation history).

**8. [P15](#p15-stream-json-version-gate) — Version gate + divergence telemetry** — New `FeedId::SUPERVISOR_TELEMETRY = 0x53` broadcast feed (next free slot after `SESSION_STATE`). Runtime version capture from `system_metadata.version` into `LedgerEntry`, exposed via `CodeSessionStore`'s public API. Structured `stream_json_divergence` events on `SUPERVISOR_TELEMETRY` when the runtime shape doesn't match the pinned golden catalog. Tugdeck-side: persistent "⚠ Claude Code version drift" banner in Tide card chrome. Version-adaptive reducer scaffold — a thin branching layer on top of the `CodeSessionStore` turn reducer, informed by which fields the store actually depends on (only legible once the store exists; hence the sequencing).
  - **Gate:** T3.4.c landed; `CodeSessionStore` reducer has run against real Claude long enough to know its version-sensitive paths.
  - **Blocks:** first external users (safety net against Anthropic version drift).

#### Optional parallel work {#execution-order-parallel}

These items do not block the critical path. Schedule opportunistically or interleave with the numbered items above if a second pair of hands is available.

- **[P16](#p16-session-command-continue) — `session_command: continue/new/fork` through the multi-session router.** Currently skipped in `v2.1.104/` + `v2.1.105/` probe manifests with §T0.5 P16 pointers. **Blocks [T3.4.d](#t3-4-d-polish-exit) multi-session** (multiple forked sessions within a Tide card), not T3.4.a/b/c. Can run in parallel with T3.4.a/b/c at any time.
- **[P20](#p20-rate-limit-event-dropped) — `rate_limit_event` routing in tugcode.** Small `tugcode/src/session.ts` allowlist extension + shape translation. Slots anywhere. Pair with rate-limit UI work whenever that lands — no hard T3.4 dependency.
- **P3, P5, P6, P8, P9, P10, P11 (LOW T0.5 items).** Genuinely defer-able. No impact on the path to first external users.

#### Summary table {#execution-order-table}

| # | Item | Depends on | Blocks |
|---|------|-----------|--------|
| 1 | [W2 closeout](#t3-workspace-registry-w2) | — | W3.a |
| 2 | [T3.0.W3.a](#t3-workspace-registry-w3a) (rename + cleanup, keep bootstrap) | W2 closeout | T3.4.a |
| 3 | [T3.4.a](#t3-4-a-code-session-store) CodeSessionStore | W3.a | T3.4.a.1, P13, T3.4.b |
| 3a | T3.4.a.1 CONTROL error routing (`session_unknown`, `session_not_owned`) | T3.4.a | T3.4.d |
| 4 | [P13](#p13-spawn-cap) spawn cap ✓ LANDED | T3.4.a | T3.4.b (advisable) |
| 5 | [T3.4.b](#t3-4-b-prompt-entry) tug-prompt-entry ✓ LANDED | T3.4.a (P13, T3.4.a.1 optional) | T3.4.c |
| 6 | [T3.4.c](#t3-4-c-tide-card) Tide card + [T3.0.W3.b](#t3-workspace-registry-w3b) bootstrap removal | T3.4.b | P14, P15, T3.4.d |
| 7 | [P14](#p14-claude-resume) `--resume` | T3.4.c | first external users |
| 8 | [P15](#p15-stream-json-version-gate) version gate | T3.4.c (reducer exists) | first external users |
| — | [P16](#p16-session-command-continue) (parallel) | — | T3.4.d multi-session |
| — | [P20](#p20-rate-limit-event-dropped) (parallel) | — | rate-limit UI |

**T3.4.a.1 scope.** Finish the `lastError.cause` surface that [§T3.4.a Spec S04](#t3-4-a-code-session-store) promised but T3.4.a shipped without: CONTROL-feed error frames for `session_unknown` (router's orphan-dispatcher path) and `session_not_owned` (router's P5 authz check) currently reach the tugdeck client but are not mapped into `CodeSessionStore.lastError`. A stale `tug_session_id` after a server reconnect sends → is rejected → the store sits in `submitting` forever with no recovery affordance (neither SESSION_STATE errored nor transport close fire on these paths). The fix is a narrow refinement to T3.4.a: add `FeedId.CONTROL` to `CodeSessionStore`'s existing filtered `FeedStore` (the per-card `tug_session_id` filter already drops app-level CONTROL frames cleanly, so `action-dispatch.ts` stays untouched); extend `frameToEvent` to map `{type: "error", detail: "session_unknown" | "session_not_owned"}` to new internal events; widen the `lastError.cause` union from three members to five; add two synthetic reducer tests mirroring the existing SESSION_STATE errored + wire_error shapes. Runs parallel with P13 and T3.4.b; gates T3.4.d (first dogfood session against a server will hit a stuck card immediately without it).

---

### Foundation: What's Been Proved {#foundation}

Full exploration journals: [transport-exploration.md](transport-exploration.md) (35 tests), [ws-verification.md](ws-verification.md) (WebSocket probe). Detailed phase writeups: [tug-conversation.md](tug-conversation.md) (Phases 1-3A.7).

#### Phase 1: Transport Exploration (DONE)

35 tests probing Claude Code's `stream-json` protocol via probe scripts (currently in `tugtalk/`, moving to `tugcode/` in Phase T0). Key discoveries that directly inform Tide's Claude Code adapter:

- **Streaming model**: `assistant_text` partials are **deltas** (not accumulated). Final `complete` event has full text. UI must accumulate.
- **Thinking**: `thinking_text` is a separate event type arriving before `assistant_text`. Same delta model. Same `msg_id`.
- **Tool use**: `tool_use` streams incrementally (empty input → full input). `tool_result` has text output. `tool_use_structured` has typed data (file viewer, bash stdout/stderr, etc.). Events interleave for concurrent tool calls.
- **Permissions & questions**: Both are `control_request_forward`. Dispatch on `is_question`. Permissions respond with `tool_approval`; questions respond with `question_answer`.
- **Interrupt**: Produces `turn_complete(result: "error")`, not `turn_cancelled`. Final `assistant_text` complete event still arrives with accumulated text.
- **Slash commands**: ALL go through `user_message`. Skills produce full event streams. Terminal-only commands (`/status`, `/model`, `/cost`) return "Unknown skill" — the UI must build its own versions (now Tide surface built-ins, Phase T10).
- **Message queueing**: Sending `user_message` mid-stream does NOT interrupt — it queues. Use `interrupt` to cancel.
- **Subagents**: `tool_use: Agent` brackets subagent lifetime. Nested tool calls visible. `system:task_started/progress/completed` provide lifecycle tracking.
- **`system_metadata`**: Sent every turn. Contains model, tools, slash_commands, skills, plugins, agents, mcp_servers, version, permissionMode. The source for all UI chrome.

**Outbound events (Claude Code → UI):**

| Event | When | Key Fields |
|-------|------|-----------|
| `protocol_ack` | After handshake | `version`, `session_id`, `ipc_version` |
| `session_init` | After claude spawns | `session_id` (may be `"pending"`) |
| `system_metadata` | Start of every turn | tools, model, slash_commands, skills, plugins, agents, mcp_servers, version, permissionMode |
| `thinking_text` | Before response | `msg_id`, `seq`, `text` (delta), `is_partial`, `status` |
| `assistant_text` | During response | `msg_id`, `seq`, `text` (delta on partial, full on complete), `is_partial`, `status` |
| `tool_use` | Tool invoked | `msg_id`, `seq`, `tool_name`, `tool_use_id`, `input` (streams empty→full) |
| `tool_result` | Tool completed | `tool_use_id`, `output`, `is_error` |
| `tool_use_structured` | Tool completed | `tool_use_id`, `structured_result` (typed: file, bash, etc.) |
| `control_request_forward` | Permission or question | `request_id`, `tool_name`, `input`, `decision_reason`, `is_question` |
| `cost_update` | Near end of turn | `total_cost_usd`, `num_turns`, `duration_ms`, `duration_api_ms`, `usage` (input/output/cache tokens) |
| `turn_complete` | End of turn | `msg_id`, `seq`, `result` (`"success"` or `"error"`) |
| `error` | Error occurred | `message`, `recoverable` |

**Inbound messages (UI → Claude Code):**

| Type | Purpose | Key Fields |
|------|---------|-----------|
| `protocol_init` | Handshake | `version: 1` |
| `user_message` | Send prompt | `text`, `attachments: []` |
| `tool_approval` | Answer permission | `request_id`, `decision: "allow"\|"deny"`, `updatedInput?`, `message?` |
| `question_answer` | Answer question | `request_id`, `answers: { key: value }` |
| `interrupt` | Stop turn | *(empty)* |
| `permission_mode` | Change mode | `mode` |
| `model_change` | Switch model | `model` |
| `session_command` | Session mgmt | `command: "fork"\|"continue"\|"new"` |
| `stop_task` | Stop a task | `task_id` |

**Session command behavior:**

| Command | Process | `session_init` ID | Readiness | Context |
|---------|---------|-------------------|-----------|---------|
| `"new"` | Kill + respawn | `"pending"` | **Gap — must wait for real ID** | Fresh |
| `"continue"` | In-place | `"pending-cont..."` | **Immediate** | Preserved |
| `"fork"` | Kill + respawn | `"pending-fork"` | **Gap — must wait for real ID** | Preserved (copy) |

#### Phase 2: Transport Hardening (DONE)

Seven fixes to make the transport production-ready. All committed:

| # | Fix | Commit |
|---|-----|--------|
| T1 | `--plugin-dir` points to `tugplug/` (skills/agents now visible) | `ec7fad06` |
| T2 | Synthetic assistant text forwarded (`/cost`, `/compact` output) | `923a655c` |
| T3 | `api_retry` events forwarded | `f3ac0249` |
| T4 | Process lifecycle: process groups, parent-death watchdog, kill_on_drop | `67c22ad1` |
| T5 | Session command readiness signaling | `314a13cc` |
| T6 | `--no-auth` flag for tugcast (dev/testing) | `ac3cdf54` |
| T7 | Tugtalk compiled to standalone binary (no Bun runtime dependency) | `70e8733e` |

#### Phase 2b: WebSocket Verification (DONE)

Probe (currently `tugtalk/probe-websocket.ts`, moving in Phase T0) verified the full WebSocket path through tugcast. See [ws-verification.md](ws-verification.md).

**Wire protocol**: All WebSocket messages are binary frames:
```
[1 byte: FeedId] [4 bytes: payload length, big-endian u32] [N bytes: payload]
```

**Feed IDs (current):**

| FeedId | Name | Direction | Payload |
|--------|------|-----------|---------|
| 0x00 | TerminalOutput | server → client | raw bytes |
| 0x10 | Filesystem | server → client | JSON |
| 0x20 | Git | server → client | JSON |
| 0x30 | Stats | server → client | JSON |
| 0x31 | StatsProcessInfo | server → client | JSON |
| 0x32 | StatsTokenUsage | server → client | JSON |
| 0x33 | StatsBuildStatus | server → client | JSON |
| 0x40 | CodeOutput | server → client | JSON-line |
| 0x41 | CodeInput | client → server | JSON-line |
| 0xFF | Heartbeat | bidirectional | empty |

**Key findings:**
- Full round-trip works: WebSocket connect → snapshot feeds → `user_message` → streamed response → `turn_complete`
- All snapshot feeds (filesystem, git, stats, project_info) delivered immediately on connect
- Reconnection works: fresh snapshot feeds on reconnect
- Heartbeat frames every 15 seconds

**Issues discovered and fixed in Phase 2c:**

| # | Issue | Fix | Commit |
|---|-------|-----|--------|
| T8 | `session_init` race — broadcast before client connects, missed on fresh launch | Dedicated watch channel, delivered as snapshot on connect | `e0174373` |
| T9 | Double delivery — snapshot feeds sent twice on connect | `borrow_and_update()` in router | `e0174373` |
| T10 | Five touchpoints to add a watch channel | `AgentBridgeHandles` encapsulation, one-file change | `e0174373` |
| T11 | `.tugtool/.session` dirties working tree | Session ID moved to tugbank | `e0174373` |

#### Phases 3A-3A.7: Markdown Rendering (DONE)

See [tug-conversation.md](tug-conversation.md) for detailed writeups. Summary of what was built:

- **3A**: Virtualized markdown rendering — BlockHeightIndex (prefix sum, binary search), RenderedBlockWindow (sliding DOM window), two-path rendering (static + streaming).
- **3A.1-3A.3**: Worker pipeline (built, then found to be unnecessary after WASM benchmarks).
- **3A.4**: pulldown-cmark WASM pipeline — 1MB in 14ms, 10MB in 132ms on JSC. Workers removed entirely. Synchronous lex + parse, no async chains.
- **3A.5**: Region model — ordered keyed content regions, imperative handle API (`setRegion`, `removeRegion`, `clear`). Ready for conversation rendering where messages arrive with IDs and are updated after display.
- **3A.6**: SmartScroll — six-phase scroll state machine (idle, tracking, dragging, settling, decelerating, programmatic). Modeled after UIScrollView/UIScrollViewDelegate. Follow-bottom, all user input methods detected.
- **3A.7**: SmartScroll hardening — settling phase, wheel/keyboard exit paths, all-key coverage, dead code removal.

**What exists and is ready for Tide phases:**
- `BlockHeightIndex` + `RenderedBlockWindow` — proven virtual scroll infrastructure
- `TugMarkdownView` with `TugMarkdownViewHandle` (setRegion/removeRegion/clear) — the rendering surface
- pulldown-cmark WASM — synchronous lex and parse
- `SmartScroll` — scroll management with follow-bottom
- `RegionMap` — ordered keyed content for conversation messages

---

### Phase T0: Naming Cleanup {#naming-cleanup}

**Goal:** Rename binaries, crates, and directories to align with the Tide architecture. The current names predate the unified surface vision and create confusion — most critically, `tugcode` (the CLI utility) occupies the name that should belong to the Claude Code bridge.

**Naming convention:** `tug{suffix}` where the suffix names the facility. Four-letter suffixes are the aspiration for primary binaries (`tugcast`, `tugdeck`, `tugcode`, `tugutil`, `tugbank`); longer suffixes are acceptable when clarity demands it (`tugshell`, `tugplug`).

**Rename table:**

| Current | New | Type | What changes |
|---------|-----|------|-------------|
| `tugcode` (Rust CLI) | **tugutil** | Binary + crate | Crate `tugcode/crates/tugcode/` → `tugrust/crates/tugutil/`. Cargo.toml `name`, `[[bin]]` target, all `use tugcode::` imports. Symlinks in `~/.local/bin/`. |
| `tugtool-core` (Rust lib) | **tugutil-core** | Library crate | Crate `tugcode/crates/tugtool-core/` → `tugrust/crates/tugutil-core/`. Cargo.toml `name`, all `use tugtool_core::` imports across workspace. |
| `tugtalk` (TypeScript) | **tugcode** | Binary + package | Directory `tugtalk/` → `tugcode/`. `package.json` name. `bun build --compile` output name. Justfile build recipe. tugapp binary copy. |
| `tugtool` (Rust launcher) | **`tugutil serve`** | Subcommand | Merge launcher logic into tugutil as `serve` subcommand. Delete `tugcode/crates/tugtool/` crate. Remove standalone binary from justfile and tugapp bundle. |
| `tugcode/` (workspace dir) | **tugrust/** | Directory | Rename workspace directory. Update `Cargo.toml` workspace path, justfile paths, tugapp build scripts, CI config. |

**What stays unchanged:**
- `tugcast`, `tugcast-core` — the WebSocket multiplexer
- `tugdeck` — the browser frontend
- `tugbank`, `tugbank-core` — the defaults database
- `tugrelaunch` — macOS app relaunch helper (internal, users never see it)
- `tugapp` — macOS app (product name: "Tug")
- `tugplug` — Claude Code plugin/agents
- `tuglaws` — design docs
- `tugmark-wasm` — WASM markdown module
- `tugshell` — shell bridge (not yet built, but name is decided)

**Scope:** ~400 occurrences across ~60 non-archive files. The heaviest areas are tugplug (174 occurrences across 20 files — every skill and agent references `tugcode` CLI commands), the Rust workspace, tugapp, CI, and documentation.

**Approach:** Interactive, one step at a time. Each step is a self-contained rename that can be verified before moving to the next. Build and test after each step to catch breakage immediately.

**Ordering rationale:** Rename the thing vacating a name before renaming the thing moving into that name. The `tugcode` name must be freed (CLI → tugutil) before it can be claimed (tugtalk → tugcode). Group each rename with all its reference updates so nothing is half-done.

**Note on archives:** Files in `.tugtool/archive/` (~1,250 occurrences) are historical records referencing names that were current when the work was done. Leave them as-is throughout.

**Steps:**

1. **Rename workspace directory `tugcode/` → `tugrust/`.**
   - `git mv tugcode tugrust`
   - Update workspace-level `tugrust/Cargo.toml` if it has self-referential paths
   - Update justfile: every `tugcode/` path → `tugrust/`
   - Update tugapp build scripts: `tugrust/scripts/build-app.sh`, Xcode project (`project.pbxproj`)
   - Update CI: `.github/workflows/ci.yml`, `.github/workflows/nightly.yml`
   - Update CLAUDE.md repository structure table
   - **Verify:** `just build` succeeds (the binaries still have their old names — only the directory moved)

2. **Rename `tugcode` crate → `tugutil` and `tugtool-core` → `tugutil-core`.**
   These are coupled — the CLI crate depends on the core library. Do them together.
   - `git mv tugrust/crates/tugcode tugrust/crates/tugutil`
   - `git mv tugrust/crates/tugtool-core tugrust/crates/tugutil-core`
   - Update `tugrust/Cargo.toml` workspace members
   - Update `tugrust/crates/tugutil/Cargo.toml`: package name → `tugutil`, bin name → `tugutil`
   - Update `tugrust/crates/tugutil/src/main.rs`: CLI struct name, `--help` description → "Tug utility — project management, state tracking, and developer tools"
   - Update `tugrust/crates/tugutil-core/Cargo.toml`: package name → `tugutil-core`
   - Find and replace across the Rust workspace: `tugtool-core` → `tugutil-core` in all `Cargo.toml` dependency declarations, `use tugtool_core::` → `use tugutil_core::` in all `.rs` files
   - Find and replace across the Rust workspace: dependency on `tugcode` → `tugutil` where other crates depend on the CLI crate (if any)
   - Update justfile: symlink names, build references
   - **Verify:** `cd tugrust && cargo build` succeeds. Binary is now named `tugutil`. `tugutil --help` works.

3. **Fold `tugtool` launcher into `tugutil serve`.**
   - Read `tugrust/crates/tugtool/src/main.rs` — extract the launcher logic
   - Add a `serve` subcommand to `tugrust/crates/tugutil/src/main.rs` with that logic
   - Remove `tugtool` from `tugrust/Cargo.toml` workspace members
   - Delete `tugrust/crates/tugtool/` directory
   - Update justfile: `dev` and `dev-watch` recipes to use `tugutil serve` instead of `tugtool`
   - Remove tugtool from justfile build recipe and tugapp bundle copy
   - **Verify:** `just build` succeeds. `tugutil serve --help` works. No `tugtool` binary produced.

4. **Rename `tugtalk/` → `tugcode/`.**
   The name `tugcode` is now free (the CLI is `tugutil`). The directory name `tugcode/` is free (the workspace is `tugrust/`).
   - `git mv tugtalk tugcode`
   - Update `tugcode/package.json`: name → `tugcode`
   - Update justfile: `tugtalk` → `tugcode` in build recipe (bun build --compile output name, source path)
   - Update `tugrust/crates/tugcast/src/feeds/agent_bridge.rs`: tugtalk binary name → `tugcode` in path resolution
   - Update tugapp: `Sources/AppDelegate.swift`, `Sources/ProcessManager.swift`, `Sources/TugConfig.swift` — tugtalk binary references → `tugcode`
   - Update tugapp `Tug.xcodeproj/project.pbxproj` if it references tugtalk
   - Update tugapp build script (`tugrust/scripts/build-app.sh`): tugtalk binary copy → tugcode
   - **Verify:** `just build` succeeds. `tugcode` binary exists (the Claude Code bridge). No `tugtalk` binary produced.

5. **Update tugplug skills and agents** (174 occurrences, 20 files).
   Every reference to the CLI tool `tugcode` in skill and agent files must become `tugutil`. These are the orchestrator commands (`tugutil dash`, `tugutil worktree`, `tugutil state`, etc.) — NOT the bridge binary.
   - `tugplug/skills/dash/SKILL.md` — 26 occurrences: `tugcode` → `tugutil`
   - `tugplug/skills/implement/SKILL.md` — 41 occurrences: `tugcode` → `tugutil`
   - `tugplug/skills/merge/SKILL.md` — 19 occurrences
   - `tugplug/skills/plan/SKILL.md` — 4 occurrences
   - All 12 agent .md files — references to `tugcode` subcommands → `tugutil`
   - `tugplug/hooks/ensure-init.sh` — 4 occurrences
   - `tugplug/hooks/auto-approve-tug.sh` — 1 occurrence
   - `tugplug/CLAUDE.md` — 1 occurrence
   - `tugplug/.claude-plugin/plugin.json` — 1 occurrence
   - **Verify:** grep confirms no remaining `tugcode` references in tugplug (all CLI references are now `tugutil`).

6. **Update tugapp references to the renamed CLI.**
   Step 4 handled tugtalk→tugcode. This step handles tugcode→tugutil for the CLI binary.
   - `Sources/AppDelegate.swift`: `tugcode` CLI references → `tugutil` (careful: distinguish from the bridge binary which IS now called `tugcode`)
   - `Sources/ProcessManager.swift`: same
   - `Sources/TugConfig.swift`: same
   - `Info.plist` if applicable
   - **Verify:** `just app` builds successfully. Tug.app bundles `tugutil`, `tugcode` (bridge), `tugcast`, `tugrelaunch`, `tugbank`.

7. **Update tugdeck.**
   - `src/main.tsx` — any `tugtalk` or old `tugcode` references
   - `vite.config.ts` — path references
   - **Verify:** `cd tugdeck && bun run build` succeeds.

8. **Update project-level files.**
   - `CLAUDE.md` — repository structure table, any references to old names
   - `.tugtool/config.toml` — if it references binary names or paths
   - `README.md` — if it references old names
   - `.claude-plugin/plugin.json` — if applicable
   - **Verify:** read each file, confirm no stale names.

9. **Update CI.**
   - `.github/workflows/ci.yml` — paths, binary names
   - `.github/workflows/nightly.yml` — same
   - **Verify:** read each file, confirm no stale names. (Full CI verification happens on push.)

10. **Final verification.**
    - `just build` — all binaries compile
    - `just test` — all tests pass
    - `just app` — Tug.app bundles correctly with renamed binaries
    - `just dev` — launches via `tugexec`
    - Grep entire repo (excluding archives) for stale `tugtalk`, stale `tugtool` (as binary name, not repo name), and `tugcode` references that should be `tugutil`
    - Smoke test: `/tugplug:dash` and `/tugplug:implement` to verify skills reference the right binary

**Exit criteria:**
- `tugutil` binary exists with all current `tugcode` subcommands
- `tugexec` binary exists, replacing `tugtool` to launch
- `tugcode` binary exists and is the Claude Code bridge (formerly tugtalk)
- No binary named `tugtool` or `tugtalk` exists
- Workspace directory is `tugrust/`
- All tugplug skills and agents reference `tugutil` (not `tugcode`) for CLI commands
- `just build && just test && just app` all succeed
- `/tugplug:dash` and `/tugplug:implement` run without "command not found" errors
- No stale references to old names in non-archive source code, config, or docs

---

### Phase T0.5: Protocol Hardening {#protocol-hardening}

**Goal:** Harden the tugcast WebSocket protocol and router to support Tide's requirements: multiple backends, opaque routing, extensibility, and robust event delivery. The current implementation was built for a single terminal + Claude Code bridge; Tide needs a general-purpose multiplexer.

**Context:** A thorough audit of the tugcast codebase (tugcast-core protocol, router, feed system, agent bridge, auth) identified 11 issues ranging from structural blockers to future-proofing concerns. All are addressed in this phase to establish the protocol as a solid foundation before building Tide's rendering and shell layers.

#### P1: Open FeedId — the extensibility gate (HIGH)

**Problem:** `FeedId` is a closed Rust enum. `from_byte()` returns `None` for unknown bytes, which becomes `ProtocolError::InvalidFeedId`. Adding a new FeedId requires modifying tugcast-core and recompiling. This directly contradicts the "opaque routing" design decision — a new `tuggemini` bridge assigning itself FeedId 0x70 would be rejected.

**Fix:** Make `FeedId` an open `u8` newtype with known variants as associated constants:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FeedId(pub u8);

impl FeedId {
    pub const TERMINAL_OUTPUT: Self = Self(0x00);
    pub const TERMINAL_INPUT: Self = Self(0x01);
    pub const TERMINAL_RESIZE: Self = Self(0x02);
    pub const FILESYSTEM: Self = Self(0x10);
    pub const GIT: Self = Self(0x20);
    // ... etc
    pub const HEARTBEAT: Self = Self(0xFF);
}
```

Frame decoding accepts any byte. Routing decisions move to the router, not the protocol layer. Code that matches on known FeedIds uses the constants; unknown FeedIds pass through without error.

**Scope:** tugcast-core `protocol.rs`, all `match` statements on `FeedId` across tugcast (add `_ =>` arms or use if/else), tests.

#### P2: Dynamic router — the multi-backend gate (HIGH) — **LANDED**

**Status:** **LANDED** (2026-04-12). Implemented across 10 steps per
`dash/tugplan-multi-session-router.md`. Full workspace checkpoint:
`cargo build` clean under `-D warnings`; `cargo nextest run` across the
full workspace → 1012 passed, 18 skipped (9 `#[ignore]`-gated real-Claude
tests, 9 pre-existing); `bun test` in tugdeck → 1924 passed, 0 failed.
Manual real-Claude run
(`TUG_REAL_CLAUDE=1 cargo nextest run -p tugcast --run-ignored only --test multi_session_real_claude`)
→ 9 passed, 0 failed against a live `claude 2.1.104` + `tmux 3.6a` +
`tugcode` stack. T3.4 (Tide Card) multi-session exit criteria are now
unblocked.

**Approved approach — client-generated session keys stamped into the payload, not new FeedIds.** Keep `CODE_OUTPUT` (0x40) and `CODE_INPUT` (0x41) as single slots in the FeedId table. Each frame's JSON payload carries a top-level `tug_session_id` field that identifies which Claude Code subprocess it belongs to. The router multiplexes multiple Claude Code bridges onto the same FeedId pair; the client filters inbound frames by `tug_session_id` and tags outbound frames with it. This keeps the FeedId namespace clean (no `CODE_OUTPUT_1`, `CODE_OUTPUT_2`, …), avoids having to renumber anything when a third backend shows up, and makes per-session subscription a client-side concern rather than a wire-level one.

**`tug_session_id` vs `claude_session_id` — two distinct concepts, two distinct names.** To prevent collision with Claude Code's own `session_id` field (which appears inside `session_init` and `system_metadata` payloads), the wire field and the Claude Code field carry distinct names:

- **`tug_session_id`** — a UUID generated by the Tide card at mount time (persisted in tugbank alongside the card id). Authoritative on the wire. Every CODE_OUTPUT and CODE_INPUT payload carries it. The client filter keys on it. The supervisor routes on it.
- **`claude_session_id`** — the UUID Claude Code emits in its own `session_init` stream-json message. Supervisor-internal only. Never authoritative on the wire. Used for diagnostics and logging; the supervisor holds a private `tug_session_id → claude_session_id` ledger populated when `session_init` arrives.

This separation dissolves the bootstrap race entirely. The card already knows its `tug_session_id` at mount, so there is no handoff window — no waiting, no re-keying, no synchronous rendezvous. Claude Code's `session_id` remains untouched inside `session_init` and `system_metadata` payloads, and the existing `SessionMetadataFeed` / `SessionMetadataStore` keep working without changes.

Concretely:
- Every `CODE_OUTPUT` frame payload gains a top-level `tug_session_id: string` field, spliced in by the bridge after it knows the id (see §2 below).
- Every `CODE_INPUT` frame payload carries `tug_session_id`; a dispatcher task demuxes to the matching Claude Code subprocess.
- `FeedStore` gains a lightweight filter API so `CodeSessionStore` subscribes as `new FeedStore(conn, [CODE_OUTPUT], decode, (_fid, decoded) => decoded.tug_session_id === key)` and only sees its own frames.
- Opening a second Tide card generates a fresh `tug_session_id` and sends a `spawn_session` control frame carrying it. The supervisor spawns a new Claude Code subprocess the first time that session receives a CODE_INPUT frame (lazy spawn — see §5 below).

**Already landed — the dynamic-backend refactor.** An earlier draft of this section described a refactor from hardcoded `terminal_tx` / `code_tx` / `code_input_tx` fields on `FeedRouter` to dynamic `HashMap<FeedId, …>` maps, together with a `register_stream` / `register_input` / `add_snapshot_watches` registration pattern. That work is **already in the tree** (see `tugrust/crates/tugcast/src/router.rs:157` and `main.rs:319–360`). `handle_client` already dispatches inputs via map lookup, and the server→client loop already fans in broadcast receivers dynamically via `tokio_stream::StreamMap`. No struct rewrite is required for P2. The remaining work — and the load-bearing piece — is the multi-session runtime below.

**What P2 actually has to build.** The wire contract above is only a sketch of the contract. The runtime architecture needs:

1. **A tugcode supervisor.** Today `main.rs:309` spawns exactly one `spawn_agent_bridge`. Multi-session requires a supervisor module at `tugcast/src/feeds/agent_supervisor.rs` that spawns Claude Code subprocesses on demand (keyed by `tug_session_id`), tracks each subprocess's `claude_session_id` in a private ledger once `session_init` arrives, and reaps subprocesses on `close_session`.

2. **`tug_session_id` stamping in the bridge.** Claude Code's stream-json does not emit `tug_session_id` — that's our field. The bridge is spawned with its `tug_session_id` as a constructor argument and byte-splices `"tug_session_id":"<id>",` as the first field of every outbound JSON line before publishing to the merger. Cheap (~one allocation per frame) and purely additive — Claude Code's own `session_id` field is never touched, and existing consumers (`SessionMetadataFeed`, future tools) stay semantically intact.

3. **CODE_INPUT input demux** (option (a) from the assessment). Keep `input_sinks` as-is — one sender per FeedId. The `FeedId::CODE_INPUT` slot maps to a dispatcher task that owns a `HashMap<TugSessionId, mpsc::Sender<Frame>>`. On each inbound CODE_INPUT frame the dispatcher parses out `tug_session_id` and forwards to the matching subprocess sender. Unknown session → reject with a `session_unknown` error control frame (see §4 control surface). The `input_sinks` generalization to a polymorphic `InputRoute` type is premature and deferred.

4. **CODE_OUTPUT output merge** (option (a) from the assessment). N bridges funnel through a merger task that owns the single CODE_OUTPUT broadcast sender plus a `HashMap<TugSessionId, RingBuffer<Frame>>` — **per-session replay buffers**, not one shared buffer. Per-session buffers keep reconnect traffic scoped: a reconnecting client replays only its own session's history, not every session's. The merger also owns P4's lag-recovery policy per session.

5. **Lazy spawn-on-first-input.** A Tide card at mount sends `spawn_session(tug_session_id)` on CONTROL, but the supervisor does **not** spawn a Claude Code subprocess yet — it registers an intent record in its ledger. The subprocess is spawned the first time a CODE_INPUT frame for that `tug_session_id` arrives. This cap-by-construction prevents 20 mounted but unused cards from pinning 20 Claude Code processes, and also makes reload-after-crash cheap (the reload rebinds intent records without spawning anything until the user types).

6. **Queued CODE_INPUT during spawn.** Between the first CODE_INPUT arrival and the child process's stdin being writable there is a brief window where frames must be buffered. The dispatcher holds a bounded per-session queue (cap 256 frames, configurable) that drains into the subprocess stdin once ready. Overflow emits a `session_backpressure` control frame and drops further frames until drain.

7. **Session lifecycle feed — new FeedId slot `SESSION_STATE = 0x52`.** A broadcast feed carrying per-session lifecycle transitions: `pending` (intent registered) → `spawning` → `live` (after `session_init` from Claude Code) → `errored(reason)` → `closed`. Each frame payload is `{tug_session_id, state, detail?}`. Cards subscribe with a session-keyed filter, same pattern as CODE_OUTPUT. This is the ACK mechanism for `spawn_session` and the place the card reads when deciding whether to enable the submit button or show a spawn error.

8. **Control-frame surface.** New CONTROL (0xc0) actions: `spawn_session{tug_session_id}`, `close_session{tug_session_id}`, `reset_session{tug_session_id}` (kill and re-register intent). Errors reported via `SESSION_STATE` transitions rather than control-frame replies.

9. **FeedStore client filter API.** `FeedStore` gains an optional per-instance filter: `new FeedStore(conn, feedIds, decode, filter?)`. The filter runs after decode, before snapshot update, on both live frames and the `TugConnection.lastPayload` replay cache. Small change in `tugdeck/src/lib/feed-store.ts`; this lands in P2 because it is part of the wire/filter contract. `CodeSessionStore` itself stays scheduled for T3.4.

10. **Cross-client multi-session — P5 relaxation.** The input-ownership lock in `router.rs:663` currently locks CODE_INPUT single-writer per `FeedId`. Relax to `(FeedId, tug_session_id)`: two browsers each owning a Tide card for different `tug_session_id`s both succeed; a second claim on the same `tug_session_id` is still rejected. This is declared in scope for v1 — we are not deferring cross-client multi-session behind an "intra-client only" fallback.

11. **tugbank persistence.** The card ↔ `tug_session_id` mapping lives in tugbank under a new domain (`dev.tugtool.tide.session-keys` or similar). Card id and `tug_session_id` have distinct lifecycles — "reset this card's session" mints a new `tug_session_id` without disturbing the card id. On reload, the supervisor rebinds existing intent records from tugbank; the Claude Code subprocess is not resumed (reload-with-same-key = fresh history, per D-T3-09). Claude Code's own `session_id` from the prior life is discarded — it's supervisor-internal state.

12. **Tests against real Claude Code — no mocks, no bridge test-mode.** Integration tests spawn the real Claude Code binary, gated on its availability in the environment. Deterministic-enough prompts (e.g., `> /status`, `> say exactly the word hello`) exercise the pipeline without depending on LLM output details. Tests that require Claude Code are marked `#[ignore]` unless a feature flag or env var enables them, so non-Claude CI stays green. This matches the user's direction: "build against the real software."

**This is plan-sized work.** P2 wants its own plan document (proposed title: `tug-multi-session-router.md`), not a direct implementation pass out of this section. See `dash/code-session-remediation.md` for the full assessment and decision log that informed this rewrite.

**Scope:** new `tugcast/src/feeds/agent_supervisor.rs` (supervisor + CODE_INPUT dispatcher + CODE_OUTPUT merger with per-session replay); modifications to `tugcast/src/feeds/agent_bridge.rs` (per-session lifecycle, `tug_session_id` splice on every frame, `claude_session_id` ledger entry on `session_init`), `tugcast/src/router.rs` (P5 ownership relaxation to `(FeedId, tug_session_id)`, bounded per-session queue on orphan CODE_INPUT rejection), `tugcast/src/main.rs` (register supervisor instead of single bridge, register `SESSION_STATE` broadcast), `tugcast/src/feeds/code.rs` (payload helpers for splice and parse); `tugcast-core/src/protocol.rs` (`SESSION_STATE = 0x52` constant); `tugdeck/src/lib/feed-store.ts` (optional filter argument), `tugdeck/src/protocol.ts` (`SESSION_STATE` constant and control action types); tugbank schema addition for the card ↔ `tug_session_id` map. Integration tests live under `tugrust/crates/tugcast/tests/multi_session_real_claude.rs` (name TBD), gated on Claude Code availability.

#### P2 integration reference: driving the multi-session router from a client {#p2-integration-reference}

This section is the **stabilized client-facing surface** of the multi-session router for follow-on work (T3.4.a/b/c/d, P13, P14). It is deliberately short and cross-references [`dash/tugplan-multi-session-router.md`](tugplan-multi-session-router.md) for full implementation history and rationale. A fresh session implementing a tugdeck store, a Rust-side follow-on, or a debugging probe should be able to read this section alone and know where to hook in without spelunking the plan doc.

**Wire frames (stabilized):**

| FeedId | Name | Payload shape (JSON) | Direction |
|--------|------|----------------------|-----------|
| `0x40` | `CODE_OUTPUT` | `{tug_session_id, ...Claude Code stream-json event}` — `tug_session_id` is spliced as the **first field** by `feeds::code::splice_tug_session_id`; subsequent fields are `type` + whatever Claude Code emits (`session_init`, `assistant_text`, `tool_use`, `turn_complete`, etc.). | server → client |
| `0x41` | `CODE_INPUT` | `{tug_session_id, type: "user_message", text, attachments, ...}` — `tug_session_id` injected as the first field by `encodeCodeInput(msg, tugSessionId)`. tugcode's `isInboundMessage` ignores extra fields so `tug_session_id` passes through harmlessly. Supported `type`s are `user_message`, `tool_approval`, `question_answer`, `interrupt`, `permission_mode`, `model_change`, `session_command`, `stop_task` — see `tugcode/src/types.ts`. | client → server |
| `0x51` | `SESSION_METADATA` | Claude `system_metadata` events, tagged with `tug_session_id`. **Broadcast feed**, not a watch channel — concurrent sessions can emit without clobber. Per-session latest-metadata replay on reconnect is fired event-driven inside `handle_control("spawn_session")` ([D14]/[F13]); there is no post-handshake replay hook. | server → client |
| `0x52` | `SESSION_STATE` | `{tug_session_id, state, detail?}` with `state ∈ {pending, spawning, live, errored, closed}`. `detail` is set on `errored` (`crash_budget_exhausted`, `merger_unavailable`, future `concurrent_session_cap_exceeded`, `spawn_rate_limited` from P13). | server → client |
| `0xc0` | `CONTROL` | Either **session lifecycle**: `{action: "spawn_session"\|"close_session"\|"reset_session", card_id, tug_session_id}` (both fields required — supervisor rejects missing with a CONTROL error frame), OR **error/signal**: `{type: "error", detail: "..."}` / `{type: "session_backpressure", tug_session_id}` / `{type: "session_unknown", tug_session_id}`. | bidirectional |

**Lifecycle — expected frame order for a typical card:**

```
(client → server)  CONTROL  spawn_session{card_id, tug_session_id}
(server → client)  SESSION_STATE  pending
                   [if reconnect with persisted latest_metadata:
                    SESSION_METADATA  system_metadata   ← event-driven replay]
(client → server)  CODE_INPUT  user_message{tug_session_id, text, ...}
(server → client)  SESSION_STATE  spawning
                   CODE_OUTPUT    session_init{tug_session_id, session_id: claude_session_id, ...}
                   SESSION_STATE  live                 ← atomic-promoted with queue drain
                   SESSION_METADATA  system_metadata   ← live, ongoing
                   CODE_OUTPUT    assistant_text{...}  ← streaming
                   CODE_OUTPUT    turn_complete
(client → server)  CONTROL  close_session{card_id, tug_session_id}
(server → client)  SESSION_STATE  closed
```

Key properties (don't waste a session rediscovering these):

- **Lazy spawn.** `spawn_session` alone does NOT launch a `claude` subprocess. The ledger enters `Idle` (wire `pending`). The first CODE_INPUT flips `Idle → Spawning` and fires the spawn. A UI can use this distinction to drive submit-button enablement.
- **Ledger state vs wire state alignment** ([B3 alignment, 2026-04-12]). `SpawnState::Live` (ledger) means exactly the same thing as wire `"live"`: session_init received and queue drained. The promote is atomic under one ledger-entry lock inside `relay_session_io`'s session_init handler. Don't add intermediate interpretations.
- **Idempotent `spawn_session`.** Duplicate spawns for the same `(card_id, tug_session_id)` are no-ops on the ledger entry but re-publish `pending` and re-fire the event-driven metadata replay — safe for reconnects.
- **P5 authz cross-check.** A client MUST send `spawn_session` for a given `tug_session_id` before sending `CODE_INPUT` for it. Unregistered ids hit the router-side P5 authz check and get rejected with `{detail: "session_not_owned"}`. Missing `tug_session_id` on CODE_INPUT is rejected with `{detail: "missing_tug_session_id"}`. An actually orphaned session (owned by the client but missing from the ledger) falls through to the dispatcher and gets `{type: "session_unknown"}` — practically unreachable under the current wiring.
- **P5 relaxation.** Two distinct clients can each claim `(CODE_INPUT, tug_session_id)` ownership for distinct `tug_session_id` values simultaneously. Same-id duplicate claims are rejected with `{type: "input_claimed", owner}`.

**tugdeck client surface — protocol.ts exports:**

```ts
// FeedId and action names
FeedId.SESSION_STATE    === 0x52;          // also exported as FEED_ID_SESSION_STATE
FeedId.SESSION_METADATA === 0x51;
FeedId.CODE_INPUT       === 0x41;
FeedId.CODE_OUTPUT      === 0x40;
FeedId.CONTROL          === 0xc0;
CONTROL_ACTION_SPAWN_SESSION === "spawn_session";
CONTROL_ACTION_CLOSE_SESSION === "close_session";
CONTROL_ACTION_RESET_SESSION === "reset_session";

// Wire frame builders
encodeSpawnSession(cardId, tugSessionId): Frame;
encodeCloseSession(cardId, tugSessionId): Frame;
encodeResetSession(cardId, tugSessionId): Frame;
encodeCodeInput(msg, tugSessionId): ArrayBuffer;  // returns already-encoded bytes
```

**Typical tugdeck client flow:**

```ts
import { FeedStore } from "@/lib/feed-store";
import { getConnection } from "@/lib/connection-singleton";
import {
  FeedId, encodeFrame, encodeSpawnSession, encodeCloseSession, encodeCodeInput,
} from "@/protocol";

// 1. Mint a tug_session_id on card mount (persist alongside card_id in tugbank).
const tugSessionId = crypto.randomUUID();
const cardId = /* from card props */;
const conn = getConnection()!;

// 2. Subscribe to the session-scoped feeds with a per-card filter ([D11]).
const filterForThisSession = (_feedId, decoded: unknown) =>
  (decoded as any).tug_session_id === tugSessionId;

const codeStore  = new FeedStore(conn, [FeedId.CODE_OUTPUT],     undefined, filterForThisSession);
const stateStore = new FeedStore(conn, [FeedId.SESSION_STATE],   undefined, filterForThisSession);
const metaStore  = new FeedStore(conn, [FeedId.SESSION_METADATA], undefined, filterForThisSession);

// 3. Register the intent with the supervisor.
const spawnFrame = encodeSpawnSession(cardId, tugSessionId);
conn.send(spawnFrame.feedId, spawnFrame.payload);

// 4. Send the first user message (this is what actually spawns the subprocess).
const codeInputBytes = encodeCodeInput(
  { type: "user_message", text: "/status", attachments: [] },
  tugSessionId,
);
// `encodeCodeInput` returns an already-encoded ArrayBuffer for historical
// reasons; to use conn.send() with its (feedId, payload) signature, slice off
// the 6-byte header OR just call the low-level ws.send path. The cleanest
// idiom is to reach into the Frame struct via encodeFrame in the future —
// T3.4.a should unify these.

// 5. Observe stateStore.getSnapshot() / codeStore.getSnapshot() via useSyncExternalStore.

// 6. Teardown:
const closeFrame = encodeCloseSession(cardId, tugSessionId);
conn.send(closeFrame.feedId, closeFrame.payload);
codeStore.dispose();
stateStore.dispose();
metaStore.dispose();
```

**Server-side entry points (Rust, for P13 / P14 / debugging):**

| Symbol | File:line | Purpose |
|--------|-----------|---------|
| `AgentSupervisor` | `tugcast/src/feeds/agent_supervisor.rs` | Central owner of per-session state. Fields: `ledger`, `client_sessions`, `session_state_tx`, `session_metadata_tx`, `code_output_tx`, `control_tx`, `store: Arc<dyn SessionKeysStore>`, `spawner_factory`, `merger_register_tx`. |
| `LedgerEntry` | same | Per-session record. Fields: `tug_session_id`, `claude_session_id: Option<String>`, `spawn_state`, `crash_budget`, `queue: BoundedQueue<Frame>`, `latest_metadata: Option<Frame>`, `input_tx: Option<mpsc::Sender<Frame>>`, `cancel`. |
| `SpawnState` | same | `Idle → Spawning → Live → {Errored, Closed}`. See `try_transition` for the allowed edges. Ledger `Live` ≡ wire `live` ≡ session_init received. |
| `AgentSupervisor::handle_control` | same | Entry point for CONTROL session actions. Called from `router::intercept_session_control`. Returns `ControlError` on payload-validation failure; caller converts to a `send_control_json` CONTROL error frame. |
| `AgentSupervisor::dispatch_one` / `dispatcher_task` | same | CODE_INPUT routing: parse `tug_session_id`, lookup ledger, branch on state. `Idle` triggers lazy spawn; `Spawning` buffers in `LedgerEntry::queue`; `Live` forwards via `input_tx`. |
| `AgentSupervisor::merger_task` | same | Fan-in of per-session bridge outputs. Re-tags `system_metadata` frames as `SESSION_METADATA` before publishing on `session_metadata_tx` and writing to `LedgerEntry::latest_metadata`. |
| `AgentSupervisor::spawn_session_worker` | same | Per-session bridge spawn. Registers with merger, installs `input_tx`, launches `run_session_bridge`. **P13 hook point:** the concurrent-session cap + rate-limit check goes at the top of this function, before any channel allocation. |
| `AgentSupervisor::rebind_from_tugbank` | same | Startup rebind from `SESSION_KEYS_DOMAIN`. Creates Idle ledger entries; does NOT touch `client_sessions`. **P14 hook point:** extend to read a JSON blob containing `claude_session_id`. |
| `SessionKeysStore` trait | same | Narrow persistence surface (`set_session_key` / `delete_session_key` / `list_session_keys`). Implemented for `TugbankClient` (production) and three test fakes. **P14 hook point:** extend the trait and blob shape to persist `(tug_session_id, claude_session_id)`. |
| `SESSION_KEYS_DOMAIN` | same | `"dev.tugtool.tide.session-keys"`. The tugbank domain the supervisor owns. |
| `run_session_bridge` / `relay_session_io` | `tugcast/src/feeds/agent_bridge.rs` | Per-session subprocess loop + relay. `relay_session_io`'s `session_init` handler is the **atomic-promote point** for ledger `Live` — it's where `claude_session_id` is captured today. **P14 hook point:** add tugbank persistence inside the same lock-held block. |
| `ChildSpawner` trait + `TugcodeSpawner` | same | Subprocess spawn abstraction. Tests inject mock spawners (`StallSpawner`, `CrashingSpawner`, `ScriptedSpawner` future). **P14 hook point:** `TugcodeSpawner::new` gains an optional `resume_claude_session_id` field that `run_session_bridge` reads from the ledger entry before calling `spawner.spawn_child()`. |
| `authorize_and_claim_input` / `InputDecision` | `tugcast/src/router.rs` | P5 authz + ownership claim helper. Returns `Forward / MissingSession / NotOwned / Claimed(owner)`. |
| `intercept_session_control` / `ControlIntercept` | same | CONTROL-branch intercept for session lifecycle actions. Routes to supervisor; converts `ControlError` variants to wire detail strings. |
| `teardown_client` | same | Every `handle_client` exit path. Calls `release_inputs` + `supervisor.on_client_disconnect(client_id)`. |

**Follow-on hook points (grep-friendly summary):**

- **T3.4.a CodeSessionStore** — wraps `FeedStore(conn, [CODE_OUTPUT], _, filter)`, consumes the filter API from `tugdeck/src/lib/feed-store.ts`, dispatches via `encodeCodeInput(msg, tugSessionId)` from `tugdeck/src/protocol.ts`. Uses `encodeSpawnSession` / `encodeCloseSession` / `encodeResetSession` for lifecycle CONTROL frames. Detailed scope under §T3.4.a below.
- **P13 spawn cap** — `AgentSupervisor::spawn_session_worker` early-exit; `AgentSupervisorConfig::{max_concurrent_sessions, max_spawns_per_minute}`; `ControlError::CapExceeded`. See §T0.5 P13.
- **P14 --resume** — `LedgerEntry::claude_session_id` is captured today but not persisted; persist in `relay_session_io`'s atomic-promote block via an extended `SessionKeysStore`; thread through `TugcodeSpawner::resume_claude_session_id`; update `rebind_from_tugbank` to read the new blob shape. See §T0.5 P14.

**Integration tests as living documentation:**

`tugrust/crates/tugcast/tests/multi_session_real_claude.rs` is the authoritative integration-level behavior spec. Each test maps to a specific [D*] decision in `tugplan-multi-session-router.md`. Reading the nine tests is a faster way to understand expected wire behavior than walking the Rust code. Run them with:

```sh
cd tugrust && TUG_REAL_CLAUDE=1 cargo nextest run -p tugcast --run-ignored only
```

Requires a real `claude` binary on PATH (tested against `claude 2.1.104`) + `tmux 3.6a`+. The test helper (`tests/common/mod.rs`) also contains a minimal `TestWs` client wrapper with frame-preserving buffering — useful as a reference for any external tool that wants to drive the multi-session router over WebSocket.

#### P2 follow-up: golden stream-json catalog (Layer A, pre-T3.4.a) {#p2-followup-golden-catalog}

**Status:** Pre-T3.4.a task. Lands as one coherent commit covering TestWs helper extensions, the capture binary, the initial baseline, prose rename + version banner, the drift regression test, recovery workflow docs, and the pre-T3.4.a verification run.

**Problem:** [`dash/transport-exploration.md`](transport-exploration.md) is a 35-test empirical catalog of Claude Code stream-json semantics, captured against `claude 2.1.87` (via the now-renamed `tugtalk`, which is the legacy name for what is now `tugcode`) and spot-verified at `2.1.104`. But the catalog is prose — there's no machine-readable fixture, no version label on individual tests, and no regression test that would flag drift when Anthropic ships a new Claude Code version (which they do frequently; stream-json is not a stable public API). T3.4.a's `CodeSessionStore` is about to build a turn-state machine directly on top of these event shapes. Any silent drift in the catalog corrupts the store's state — exactly the failure mode T3.4.a's "essential wire-level invariants" callout warns about.

This task is the **safety net** for T3.4.a: capture the catalog as versioned machine-readable fixtures and add a regression test that fails loudly on drift. It is deliberately scoped: it does NOT include runtime divergence handling, UI surfacing, or version-adaptive parsing. Those are [P15 below](#p15-stream-json-version-gate).

**Operating model:** These tests are **not** part of the routine build or nextest run. They vet a protocol that changes outside our control and are intended to run manually — roughly once per several days, or once per Claude Code version bump. Completeness and correctness matter far more than speed. The capture covers **all 35 probes** (not a curated subset), every probe runs in a fresh `TestTugcast` subprocess for clean isolation, and session-command probes (13, 17, 20) deliberately exercise uncharted supervisor territory — if they expose bugs, that's a bonus finding to log as a follow-up, not a reason to skip.

**Fix:**

0. **Extend `TestWs` with control-flow send helpers.** The current helper only supports `user_message` + `spawn_session` / `close_session` / `reset_session`. Probes 6 (interrupt), 11 (tool deny round-trip), 35 (`AskUserQuestion` answer), and 13/17/20 (session_command) need additional inbound message types. Before writing helpers, **verify the router's `CODE_INPUT` path passes arbitrary tugcode JSON through verbatim** — if the router's `authorize_and_claim_input` code path assumes a `user_message` shape, widen it to opaque JSON pass-through (tugcode is the authority on message validation; tugcast is a router). Add the helpers:

   - `TestWs::send_interrupt(tug_session_id)`
   - `TestWs::send_tool_approval(tug_session_id, request_id, decision, updated_input?, message?)`
   - `TestWs::send_question_answer(tug_session_id, request_id, answers)`
   - `TestWs::send_session_command(tug_session_id, command: "new" | "continue" | "fork")`
   - `TestWs::send_model_change(tug_session_id, model)` (used by Test 16)
   - `TestWs::send_permission_mode(tug_session_id, mode)` (used by Test 12 coverage)

   Each helper ships with a narrow `#[ignore]`-gated round-trip integration test that drives a real claude and asserts the inbound message reached tugcode (by observing the correct outbound event type — e.g., `send_interrupt` → observe `turn_complete.result == "error"`). These helper tests live alongside the multi-session tests in `tests/multi_session_real_claude.rs`.

1. **Capture binary.** New `tugrust/crates/tugcast/tests/capture_stream_json_catalog.rs`, a `#[ignore]`-gated `#[tokio::test]` that is not part of the default nextest suite. Invocation:

   ```sh
   cd tugrust && TUG_REAL_CLAUDE=1 cargo test --test capture_stream_json_catalog -- --ignored
   ```

   Architecture:

   - **Per-probe isolation.** One fresh `TestTugcast` + `TestWs` per probe, torn down before the next probe begins. No cross-probe state bleed. Slower than shared-tugcast mode; speed is explicitly not the concern here.
   - **Probe table.** A single Rust data structure listing all 35 probes, each with: `probe_name`, `input_script` (ordered list of inbound messages + optional "wait for event type" gates between them), `required_events` (event types that MUST appear, shape-checked), `optional_events` (event types that MAY appear, shape-checked only if present), `prerequisites` (e.g., tugplug plugin loaded, denial-capable tool path), and `timeout_secs`.
   - **Probe lifecycle.** For each probe: spawn TestTugcast → open TestWs → send `spawn_session` → execute the probe's input_script → collect all `CODE_OUTPUT` and `SESSION_METADATA` frames (both feeds, interleaved by arrival order, each frame tagged with its `feed_id`) until the probe's terminal event (typically `turn_complete`) or the probe's timeout → send `close_session` → kill TestTugcast.
   - **Version detection.** The first probe (Test 1, basic round-trip) reads `system_metadata.version` from the first event that carries it; all subsequent probes commit their fixtures to `v<version>/`. If a later probe observes a different version value, abort the whole run (indicates a concurrent install change).
   - **Retry + skip policy.** If a probe fails to produce its `required_events` within the timeout, retry up to 3 times. After the third failure, mark the probe `skipped` with a structured reason in the manifest. Prerequisite-gated probes (25, 28, 34, 35 — tugplug plugin dependencies) are checked at probe-entry; on missing prerequisite, the probe is `skipped` with `reason: "tugplug plugin not loaded"` (not a failure).
   - **Stability mode.** Flag `--stability N` (default 1 for re-runs, 3 for the initial baseline) runs each probe N times and asserts shape-identity across runs. If a probe is shape-unstable (e.g., `thinking_text` present in run 1, absent in run 2), the capture binary **does not** pick one run arbitrarily — it requires the probe table to reclassify the flapping event as OPTIONAL, then re-run. This is the only way the initial `v2.1.104/` baseline can be trusted.
   - **Fixture output.** Per probe: one JSONL file at `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v<version>/<probe-name>.jsonl` with normalized events (see Step 4). Per run: one `v<version>/manifest.json` listing probe_name, status (`passed` | `skipped` | `failed`), event counts, runtime, and (for skips) reason. Per run: one `v<version>/schema.json` derived from the raw JSONL (see Step 4).

2. **Initial baseline capture.** Run the capture binary against the currently-installed `claude 2.1.104` with `--stability 3`. Review `manifest.json`. For any probe marked `failed` or shape-unstable: diagnose, reclassify events as REQUIRED/OPTIONAL in the probe table, re-run. Iterate until either (a) all 35 probes pass stability, or (b) any remaining skips are explicitly justified (environment-dependent or blocked on a logged supervisor bug). Commit the stabilized `v2.1.104/` directory as the golden reference.

   Session-command probes (13, 17, 20) and tugplug probes (25, 28, 34, 35) are expected to be the rough edges. If the capture surfaces supervisor bugs when routing `session_command: new/continue/fork` through the multi-session router, **capture those bugs as new follow-up items in this §T0.5** (nominate them P16/P17/… as appropriate) rather than blocking Layer A landing. Fixtures for affected probes either land (if they stabilize despite the bug) or are marked `skipped` with an inline `reason: "blocked on P16 supervisor session_command routing"` pointer.

3. **Prose rename pass + version banner on `transport-exploration.md`.**

   - **Rename `tugtalk` → `tugcode`** throughout the prose. The old name is a legacy artifact and confuses readers encountering this doc for the first time.
   - **Version banner** at the top of the doc:
     > *This document was empirically verified against `claude 2.1.87` (initial capture, 2026-03-29) and `2.1.104` (Step 10 multi-session integration run, 2026-04-12). The **authoritative machine-readable golden fixtures** live at `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/` and are ground truth — this prose catalog is a human-readable summary that may lag behind the fixtures. If the drift test ([§P2 follow-up](tide.md#p2-followup-golden-catalog)) fails, the fixtures are correct and this document is stale; update the prose to match.*
   - **"Known divergences from prose catalog"** section, at the top, listing any deltas surfaced during the Step 2 baseline capture (events the prose mis-describes, fields the prose doesn't mention, chunk-count differences between `2.1.87` and `2.1.104`). Each delta gets one bullet pointing at the fixture file and the prose section.

4. **Fixture normalization + schema manifest.** Normalization runs at fixture-write time in the capture binary. `normalize_event(json)` substitutes non-deterministic values with typed placeholders so re-captures of unchanged shapes produce byte-stable files:

   - `session_id` values → `"{{uuid}}"`
   - `tool_use_id` → `"{{tool_use_id}}"`
   - `msg_id` → `"{{msg_id}}"`
   - `request_id` → `"{{uuid}}"`
   - ISO-shaped timestamps (`started_at`, `ended_at`, etc.) → `"{{iso}}"`
   - Cost / duration / token count numeric fields → `"{{f64}}"` or `"{{i64}}"` as typed placeholders
   - Absolute filesystem paths → `"{{cwd}}/rest/of/path"`
   - Raw text content (`assistant_text.text`, `thinking_text.text`, `tool_result.output`) → `"{{text:len=N}}"` with the original character count preserved as `N` (detects catastrophic truncation without committing noisy text)
   - `tool_use_structured.structured_result` leaf values are substituted; the enclosing object structure is preserved so its shape can still be shape-diffed

   Substitution produces technically-invalid-but-human-readable JSON that is byte-stable across captures when shapes are unchanged. A `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/README.md` (see Step 6) documents the placeholder vocabulary.

   In parallel, the capture binary derives **`v<version>/schema.json`** from the raw JSONL. The schema is a summary — one entry per observed event type — mapping `event_type → { required_fields: { name: json_type }, optional_fields: { name: json_type } }`, plus per-probe event-sequence invariants (`"probe_name": { required_sequence: [...], optional_slots: [...] }`). **Single source of truth is the JSONL**, not the schema; the schema is derived on every capture run, and if the two ever disagree the JSONL wins. `schema.json` exists so the drift test can do fast machine comparison without re-deriving per run, and so P15's runtime divergence telemetry (later) can load a version's shape corpus without re-reading 35 files.

5. **Drift regression test with hand-rolled differ.** New `tugrust/crates/tugcast/tests/stream_json_catalog_drift.rs`.

   - **Separate test runner, not in the main nextest suite.** Invocation:

     ```sh
     cd tugrust && TUG_REAL_CLAUDE=1 cargo test --test stream_json_catalog_drift -- --ignored
     ```

     Kept distinct from `cargo nextest run --run-ignored only` so routine developer workflows never touch it. Runs once per Claude Code version bump, or on a cadence of your choosing — there is **no hard runtime budget**.
   - **`#[ignore]`-gated `#[tokio::test]`** + `TUG_REAL_CLAUDE=1` env gate, same belt-and-suspenders pattern as the multi-session tests.
   - **Replays the full 35-probe suite** (no curated subset — completeness > speed). Reuses the Step 1 probe table so there is exactly one definition of what each probe is.
   - **Version resolution.** Reads installed claude's `system_metadata.version` from Test 1's output; locates `v<version>/schema.json` + `v<version>/*.jsonl`. Fails with `"no golden fixtures for claude <version>; run capture_stream_json_catalog and commit the new fixtures under v<version>/"` if no fixture directory exists for this version. Fall-back to an older version's fixtures is deliberately not supported — every version bump requires an explicit capture commit.
   - **Hand-rolled shape differ** (`~100–150 lines`, no external crate dependency). Operates on derived schemas, not raw JSONL:
     - Walk `{event_type}` keys. **Unknown event type in new run → fail.**
     - For each known event type, walk `{field_name, json_type}` pairs against the golden schema. **Missing required field → fail. Type mismatch (golden says `string`, new says `number`) → fail. New field not in golden → warn** (forward-compatibility allowance).
     - Fields whose value is `object` recurse (max depth 8; arrays-of-objects are treated as "all elements share one shape," validated against the first element's shape). Primitive arrays (`string[]`, `number[]`) compare element type only.
     - **Polymorphic `tool_use_structured.structured_result`** is handled as a union keyed on `tool_name`: Read, Bash, Glob each have their own shape entry in the schema; the differ looks up the correct subtype per event.
     - **Per-probe event-sequence invariant check.** Golden says probe X emits `[system_metadata, tool_use, tool_result, assistant_text, turn_complete]`. Added optional slot → warn. Removed required slot → fail. Reordered required slots → fail.
   - **Structured failure report** on stdout: nested bullets naming the probe, event index in stream, JSON path, golden shape, current shape, severity. Designed for human review, not automated parsing.
   - **Differ unit tests** live in a separate `#[cfg(test)]` module inside the drift test file (or as `tests/shape_differ_tests.rs` if length warrants). These are **normal nextest tests** (no `#[ignore]`, no claude dependency) because they're pure-Rust fixture comparison. ~20 hand-crafted `(golden, current, expected_report)` triples covering:
     - Identical shapes → empty diff
     - New optional field → warn only
     - Removed required field → fail
     - Type change → fail
     - Unknown event type → fail
     - Nested object shape change → fail at correct JSON path
     - Array shape change → fail
     - Polymorphic `tool_use_structured` (Read vs Glob) treated as union by `tool_name`
     - Probe sequence: added optional slot → warn; removed required slot → fail
   These tests pin the differ's semantics *independently* of any real claude fixture, so a differ bug can't silently mask or produce real drift.

6. **Recovery workflow doc.** New `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/README.md` covering:

   - What the fixtures are and how they're generated (pointer to the capture binary).
   - Placeholder vocabulary (`{{uuid}}`, `{{iso}}`, `{{f64}}`, `{{i64}}`, `{{text:len=N}}`, `{{cwd}}/...`).
   - **Recovery workflow** when the drift test fails:
     1. Re-run `TUG_REAL_CLAUDE=1 cargo test --test capture_stream_json_catalog -- --ignored` with `--stability 3` against the current claude.
     2. Diff the new `v<new>/` dir against the previous version's dir.
     3. Classify each change:
        - **Benign** (new optional event type, new optional field, newly absent optional event) → commit the new version dir, keep the old. Update `transport-exploration.md` "Known divergences" if prose lags.
        - **Semantic** (existing event removed, field renamed/removed/type-changed, required event dropped) → fix the consumer (`CodeSessionStore` under T3.4.a, or tugcode's event mapping) **first**, then commit the new fixture.
        - **Ambiguous** → stop, escalate to a discussion, then decide.
   - How to add a new probe to the capture binary's probe table.
   - How to classify an event as REQUIRED vs OPTIONAL (default: REQUIRED until stability proves otherwise; only demote after a stability run flaps the event).

7. **Pre-T3.4.a verification run.** Before T3.4.a begins, run the full Step 0 → Step 6 pipeline end-to-end as a dress rehearsal: TestWs helpers landed, capture binary runs `--stability 3` against `claude 2.1.104`, the `v2.1.104/` baseline is committed, the drift test replays the same version and passes, the recovery README exists, and `transport-exploration.md` carries the version banner + rename + divergences. Any surprises surfaced here (unexpected prose divergences, supervisor bugs from session-command probes, unstable probes that needed reclassification, polymorphic event types the differ didn't anticipate) are either fixed inline or logged as new follow-up items in this §T0.5 before T3.4.a begins.

**Scope:**

| File | Change |
|------|--------|
| `tugrust/crates/tugcast/tests/common/mod.rs` | Extend `TestWs` with `send_interrupt`, `send_tool_approval`, `send_question_answer`, `send_session_command`, `send_model_change`, `send_permission_mode` |
| `tugrust/crates/tugcast/src/router.rs` | **Conditional:** widen `CODE_INPUT` handling to opaque tugcode JSON pass-through if it currently assumes `user_message` shape |
| `tugrust/crates/tugcast/tests/multi_session_real_claude.rs` | One narrow `#[ignore]`-gated round-trip test per new helper |
| `tugrust/crates/tugcast/tests/capture_stream_json_catalog.rs` | **New.** Capture binary: probe table, per-probe isolation, retry + skip policy, `--stability N` mode, fixture normalization, `manifest.json` + `schema.json` derivation |
| `tugrust/crates/tugcast/tests/stream_json_catalog_drift.rs` | **New.** Drift regression test (full 35 probes) + hand-rolled shape differ + inline `#[cfg(test)]` differ unit tests |
| `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/README.md` | **New.** Placeholder vocabulary, recovery workflow, probe classification guide |
| `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.104/` | **New.** All 35 normalized probe JSONL files + `manifest.json` + `schema.json` |
| `dash/transport-exploration.md` | Version banner, `tugtalk`→`tugcode` rename pass, "Known divergences from prose catalog" section |
| `dash/tide.md` §T0.5 | **Conditional:** new P16/P17/… entries if session-command or tugplug probes surface supervisor bugs during the Step 2 baseline capture |

Reuses `TestTugcast` subprocess spawn pattern from Step 10 multi-session tests (`env!("CARGO_BIN_EXE_tugcast")`, `TUGBANK_PATH` isolation, per-test ephemeral ports).

**Invocation:**

```sh
# Capture — run once per Claude Code version bump, or when the probe table grows.
cd tugrust && TUG_REAL_CLAUDE=1 cargo test --test capture_stream_json_catalog -- --ignored

# Capture with stability check — required before committing a new v<version>/ baseline.
cd tugrust && TUG_REAL_CLAUDE=1 cargo test --test capture_stream_json_catalog -- --ignored --stability 3

# Drift regression — run once per version bump or on a cadence of your choosing.
cd tugrust && TUG_REAL_CLAUDE=1 cargo test --test stream_json_catalog_drift -- --ignored
```

Neither command is in the default nextest suite. Neither runs on pre-commit, pre-push, or CI. They are manual verification tools that vet a protocol maintained outside our control.

**Schedule:** Land as a coherent series of commits grouped under [`dash/tugplan-golden-stream-json-catalog.md`](tugplan-golden-stream-json-catalog.md), **before T3.4.a begins**. The tugplan splits this section's work into 8 execution steps (router pass-through audit, TestWs helpers, capture binary, baseline capture, prose rename, drift test + differ, recovery README, integration checkpoint), each with its own commit boundary. Once in place, T3.4.a can cite the golden fixtures as ground truth (`tests/fixtures/stream-json-catalog/v2.1.104/test-5-tool-use.jsonl`) instead of relying on prose descriptions, and any future Claude Code version bump runs the drift test as a first sanity check. Any supervisor bugs exposed by session-command or tugplug probes during the baseline capture step are recorded as new follow-up items in this §T0.5 and tackled in their own commits after Layer A lands.

#### P3: FeedId slot collision (LOW)

**Problem:** Tide.md proposed ShellOutput=0x50, ShellInput=0x51. But `Defaults = 0x50` already exists in the code. The roadmap's FeedId table is wrong.

**Fix:** Update the FeedId assignments:

| FeedId | Feed | Status |
|--------|------|--------|
| 0x50 | Defaults | Existing (keep) |
| 0x60 | ShellOutput | New |
| 0x61 | ShellInput | New |
| 0x70 | TugFeed | Planned |

Update tide.md's FeedId tables and all references.

#### P4: CodeOutput lag recovery (MEDIUM)

**Problem:** Broadcast channel capacity is 4096 frames. If a client lags behind on CodeOutput, events are silently lost — no bootstrap, no recovery. The client's conversation state corrupts (missed `assistant_text` deltas, `tool_use` blocks, or `turn_complete`).

Terminal output has bootstrap via `tmux capture-pane`. CodeOutput has nothing.

**Fix:** Add a CodeOutput replay buffer. The agent bridge maintains a bounded ring buffer of recent CodeOutput frames (e.g., last 1000 frames or last 60 seconds). When the router detects CodeOutput lag, it replays from the buffer instead of just logging a warning. The client receives a `lag_recovery` control frame indicating that replay is occurring, then the replayed frames, then live streaming resumes.

If the lag exceeds the buffer, send a `lag_unrecoverable` control frame. The client must request a full session resync (which the UI can handle by clearing and re-requesting state).

**Scope:** Agent bridge (add ring buffer), router (add CodeOutput lag handling parallel to terminal bootstrap), new control frame types.

#### P5: Multi-client input guard (LOW)

**Problem:** All clients' `CodeInput` frames go to the same `mpsc::Sender`. Two browser tabs sending competing `user_message` to Claude Code would interleave unpredictably.

**Fix:** Enforce single-writer-per-backend. When a client sends its first input frame for a given FeedId, it claims that input channel. Subsequent clients attempting to send on the same input FeedId receive an error frame. Read-only access (receiving output) remains open to all clients.

For Tide, where each backend has one active session, this is the right model. Multi-client collaboration (shared editing) would need a different design — defer that.

**Scope:** Router `handle_client` input dispatch (add ownership tracking per FeedId input channel).

#### P6: Protocol version documentation (LOW)

**Problem:** No version field in the frame format. No negotiation mechanism.

**Fix:** Don't change the wire format. Instead:
1. Document the current format as "Tugcast Binary Protocol v1" in tugcast-core.
2. Add a one-time handshake at WebSocket connection open: client sends a text frame `{"protocol":"tugcast","version":1}`, server responds `{"protocol":"tugcast","version":1,"capabilities":[]}`. If versions don't match, close with an appropriate WebSocket close code.
3. The capabilities array is empty for v1 but provides the extension point for future features (compression, fragmentation, subscription filtering).

**Scope:** tugcast-core (documentation), router.rs (handshake before entering feed loop), tugdeck protocol.ts (send handshake on connect).

#### P7: Raise max payload size (MEDIUM)

**Problem:** `MAX_PAYLOAD_SIZE` is 1 MB. `assistant_text` complete events contain full conversation text — observed at multi-MB in real sessions. Shell output from `cat large-file` could easily exceed 1 MB.

**Fix:** Raise to 16 MB. This is still a safety limit — it prevents a runaway feed from consuming unbounded memory. 16 MB accommodates the largest realistic single-frame payloads (full conversation text, large file contents) while remaining bounded.

If larger payloads are eventually needed (e.g., streaming a binary file), add frame fragmentation as a future protocol extension — not now.

**Scope:** tugcast-core `protocol.rs` (one constant change), tests (update boundary tests).

#### P12: Flags byte in frame header (HIGH)

**Problem:** The wire format is `[1 byte FeedId][4 byte BE u32 length][payload]`. Every frame is implicitly "data." But P4 and P11 introduce meta-frames (lag recovery, bootstrap requests) that ride on existing FeedIds. Without a framing-level way to distinguish data from control, receivers must parse JSON to tell whether a CodeOutput frame is real conversation data or a lag recovery signal. This is fragile and forces both Rust and TypeScript parsers to handle protocol-level concerns in application-level code.

**Fix:** Expand the header from 5 bytes to 6 bytes by adding a flags byte:

```
[1 byte FeedId][1 byte flags][4 byte BE u32 length][payload]
```

Flags byte layout (v1):
- Bit 0: frame kind — `0` = data, `1` = control (meta-frame about this feed)
- Bits 1–7: reserved, must be 0. Receivers ignore unknown flags for forward compatibility.

This means a lag recovery frame is `FeedId=0x40, flags=0x01, payload={"type":"lag_recovery"}` — the framing layer tells you it's not conversation data before you touch the JSON. Future uses for reserved bits: compression indicator, fragmentation, priority, etc.

The cost is 1 extra byte per frame — negligible at any realistic throughput. The benefit is that this is the last opportunity to change the wire format cleanly before external clients exist.

**Scope:** tugcast-core `protocol.rs` (Frame struct, encode/decode, HEADER_SIZE 5→6, tests), tugdeck `protocol.ts` (mirror changes), tugdeck `connection.ts` (decode path), all golden-byte tests.

#### P13: Session spawn rate limit + concurrent-session cap (HIGH) {#p13-spawn-cap}

**Prerequisite reading:** [§P2 integration reference](#p2-integration-reference) — the entry-point table names `AgentSupervisor::spawn_session_worker` as the hook point and `AgentSupervisorConfig` as the config surface.

**Problem:** The multi-session supervisor from P2 lets any number of Claude Code subprocesses spawn on demand. A user with 20 Tide cards open chews through 20 parallel `claude` processes (~hundreds of MB each, plus API token burn). A UI bug that loops `reset_session` becomes a resource bomb. `AgentSupervisorConfig` has no limits today.

**Fix:** Two-layer cap on the supervisor.

1. **Hard concurrent cap.** New field `AgentSupervisorConfig::max_concurrent_sessions` (default 8). Before `spawn_session_worker` installs `input_tx` on the ledger entry, count the current `Spawning`+`Live` entries in the ledger; if the count is at or above the cap, flip the entry to `Errored`, publish `SESSION_STATE = errored { detail: "concurrent_session_cap_exceeded" }`, and short-circuit the spawn. Tests assert that the N+1th spawn fails cleanly and the ledger entry is marked `Errored`.

2. **Leaky-bucket rate limit.** New field `AgentSupervisorConfig::max_spawns_per_minute` (default 20). A supervisor-owned `Mutex<VecDeque<Instant>>` tracks spawn timestamps; `spawn_session_worker` trims timestamps older than 60s, checks the length, and — if over the limit — publishes `SESSION_STATE = errored { detail: "spawn_rate_limited" }`. Rate-limited spawns still count against the budget on retry (no immediate bypass).

Both limits are configurable so power users and CI harnesses can raise them. `#[ignore]`-gated integration tests cover both error paths with the supervisor's existing mock-spawner infrastructure.

**Scope:** `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` (~150 lines including tests); new `ControlError::CapExceeded` variant; `handle_control` maps it to a CONTROL error frame on the in-scope socket.

**Schedule:** Land opportunistically after T3.4.a as a single-commit drop. Cheap insurance before any real user gets hold of Tide.

**Status: ✓ LANDED.** `AgentSupervisorConfig` gained `max_concurrent_sessions` (default 8) and `max_spawns_per_minute` (default 20). Enforcement lives inside `do_spawn_session`'s Phase 1 critical section via `cap_check_reason`: `Spawning`+`Live` entries are counted via non-blocking `try_lock` (`Idle` and `Errored` do not consume slots); a `Mutex<VecDeque<Instant>>` on the supervisor trims timestamps older than 60s before the length check. Rejected spawns publish `SESSION_STATE = errored { detail: "concurrent_session_cap_exceeded" | "spawn_rate_limited" }` and return `ControlError::CapExceeded { reason }`, which `intercept_session_control` in `router.rs` maps to a CONTROL error frame on the in-scope socket. Reconnects (existing ledger entry for the same `tug_session_id`) bypass both checks. Six unit tests cover the happy path, cap, rate limit, Idle/Errored exclusion, reconnect bypass, and 60s window trim — full suite 1126/1126 green.

#### P14: Claude Code `--resume` for persistent session history (HIGH) {#p14-claude-resume}

**Prerequisite reading:** [§P2 integration reference](#p2-integration-reference) — the entry-point table names the specific hook points: `LedgerEntry::claude_session_id` is captured today in `relay_session_io`'s atomic-promote block; `SessionKeysStore` is the persistence trait to extend; `rebind_from_tugbank` is where reload-side re-hydration happens; `TugcodeSpawner` is where the resume id gets threaded into the subprocess spawn. The [B3 alignment note](#p2-integration-reference) in that section also documents the atomic-promote invariant you must preserve when adding the persistence write.

**Problem:** `tugplan-multi-session-router.md §[D12]` decided "reload-with-same-key = fresh history" based on terminal-pane semantics. In practice, Tide cards are long-lived chat threads, not ephemeral terminal panes. A developer who closes their laptop at 6pm and reopens at 9am tomorrow expects their conversation to pick up where it left off. Losing accumulated context — edited files, tool_use history, slash-command state — on every reload is a severe regression for serious work. [D12]'s decision is **hereby overturned** for P14; the rationale in that section's "Implications" bullet about `--resume` not being used is superseded by this P-item.

`claude_session_id` already flows into `LedgerEntry::claude_session_id` from the bridge's `session_init` handler (see `agent_bridge.rs::relay_session_io`'s atomic-promote block), but it is never persisted — on tugcast restart, `rebind_from_tugbank` rehydrates the `tug_session_id` ledger entry with `claude_session_id: None` and the next spawn mints a fresh Claude Code subprocess.

**Fix:** Persist `claude_session_id` alongside `tug_session_id` and thread it through the spawn path so the reopened card resumes its conversation.

1. **Persist on `session_init`.** Extend the `SessionKeysStore` trait (defined in `agent_supervisor.rs`) with a `set_claude_session_id(tug_session_id, claude_session_id)` method — or, cleaner, change the stored value from a string `tug_session_id` to a JSON `{tug_session_id, claude_session_id?}` blob in the existing `dev.tugtool.tide.session-keys` tugbank domain. The atomic-promote block in `relay_session_io` already locks the ledger entry when `session_init` arrives; add a tugbank write to the same critical section so the persisted state matches the in-memory state.

2. **Thread through spawn.** Extend `AgentSupervisorConfig` (or the `TugcodeSpawner` constructor) to accept an optional `resume_claude_session_id`. `spawn_session_worker` reads `ledger_entry.claude_session_id` after the rebind path populates it; if `Some`, passes it into the spawner factory; if `None`, spawns fresh.

3. **tugcode-side plumbing.** Currently `tugcode/src/session.ts` reads its resume id from the `dev.tugtool.app / session-id` singleton path (the legacy pre-multi-session scheme that caused Step 10's stale-`--resume` bug). Switch tugcode to read the resume id from an env var or a new CLI flag (`--resume-session <id>`) that tugcast passes on spawn. tugcode's own singleton tugbank write goes away — the supervisor owns the persistence. This also cleans up the cross-test contamination from Step 10.

4. **Mimic terminal Claude Code semantics.** On fresh card mount: no persisted `claude_session_id` exists → spawn fresh. On reload of an existing card: persisted `claude_session_id` exists → `--resume` it. On explicit `reset_session`: invalidate the persisted `claude_session_id` (tugbank delete) **before** killing the subprocess, so the next spawn is fresh. `close_session` does NOT invalidate `claude_session_id` — a closed card can be reopened with history intact.

5. **Tests.**
   - `test_spawn_session_resumes_persisted_claude_session_id` — unit test with an `InMemorySessionKeysStore` pre-populated with `(card_id, tug_session_id, claude_session_id)`, asserts the spawner receives the resume id.
   - `test_reset_session_clears_persisted_claude_session_id` — asserts `reset_session` deletes the claude_session_id binding before the subprocess restart.
   - `test_session_init_persists_claude_session_id` — drives `relay_session_io` via duplex streams; asserts tugbank gets the write atomically with the ledger update.
   - Real-claude integration test: `test_close_then_reopen_preserves_history` — open a session, exchange a turn that establishes known context ("remember the word gazebo"), close the WebSocket, reopen, send a probe ("what word did I tell you to remember?"), assert the response contains "gazebo". Pins the resume path end-to-end.

**Scope:** `tugcast/src/feeds/agent_supervisor.rs` (trait extension, ledger persistence hook); `tugcast/src/feeds/agent_bridge.rs` (TugcodeSpawner resume field + relay_session_io persistence hook); `tugcode/src/session.ts` + `tugcode/src/tugbank-client.ts` (drop the singleton resume id path, accept resume id from env/CLI); update `rebind_from_tugbank` to read the new JSON blob shape.

**Schedule:** Land after T3.4.a so there's real UI feedback on what "resume" should feel like per card. Before any external users see Tide.

#### P15: Stream-json version gate + divergence telemetry (HIGH) {#p15-stream-json-version-gate}

**Prerequisite reading:** [§P2 follow-up: golden stream-json catalog](#p2-followup-golden-catalog) establishes the shape baseline and the drift test. P15 builds on that foundation by adding runtime divergence handling and version-adaptive parsing. **Must not land before the golden catalog exists** — Layer B's divergence detection has nothing to compare against without the fixtures, and Layer C's version-adaptive reducer has no recorded version bands to dispatch on.

**Problem:** Claude Code's stream-json format is not a stable public API. Anthropic ships new versions on an irregular cadence, and past versions have changed event shapes, renamed fields, and introduced new event types. The golden catalog from the P2 follow-up gives us a static safety net — a drift test that fails when the fixtures no longer match — but the running system has no way to *handle* drift at runtime:

- **tugcode's `isInboundMessage`** silently drops unknown event types with a `console.error` to stderr. Invisible to the client. If `claude 2.2.0` ships a `frobnicate_text` event, tugcode drops it and `CodeSessionStore` never sees a turn complete, and the spinner spins forever with no user-visible cause.
- **No version capture.** `system_metadata.version` is observable but never persisted to the ledger or forwarded to the store. Even if `CodeSessionStore` wanted to feature-flag its reducer on version, it couldn't — the field isn't in scope.
- **No version-adaptive handling.** If `claude 2.2.x` renames `assistant_text.text` → `assistant_text.content` (hypothetical, but the kind of change Anthropic has made before), `CodeSessionStore` silently corrupts every turn — the drift test catches this in CI, but there's no graceful runtime recovery path.
- **No user-visible drift signal.** Even when the server detects drift, there's no way to tell the user. A Tide card with a broken conversation is indistinguishable from a Tide card with a slow API response.

**Fix:** Two layers on top of the golden catalog.

**Layer B — Runtime divergence telemetry.**

1. **New FeedId: `SUPERVISOR_TELEMETRY = 0x53`.** Next free slot in the defaults/session section after `SESSION_STATE = 0x52`. Broadcast feed registered via `register_stream(FeedId::SUPERVISOR_TELEMETRY, telemetry_tx, LagPolicy::Warn)` alongside SESSION_STATE and SESSION_METADATA. Carries divergence events plus any other supervisor-side telemetry that later P-items want to surface (e.g., P13 cap rejections, P14 resume failures).

2. **Structured divergence event.** Payload shape:
   ```json
   {
     "type": "stream_json_divergence",
     "claude_version": "2.2.0",
     "kind": "unknown_event_type" | "missing_required_field" | "type_mismatch",
     "raw": { "type": "frobnicate_text", "foo": "bar" },
     "context": { "tug_session_id": "...", "msg_id": "...", "seq": 42 },
     "timestamp_ms": 1712345678901
   }
   ```
   The `raw` field is the full offending payload (bounded to ~4 KB so a pathological producer can't blow the wire). `kind` is a discrete enum for UI dispatching.

3. **Tugcode-side promotion.** `tugcode/src/ipc.ts`'s `isInboundMessage` detects drift (unknown `type`, missing required field, type mismatch) and emits a structured outbound event via a new `writeDivergence(kind, raw, context)` helper instead of a silent `console.error`. The event flows through the normal stdout → tugcast merger path.

4. **Supervisor-side retag.** `AgentSupervisor::merger_task` (already the fan-in point for per-session bridge output) detects `"type": "stream_json_divergence"` payloads by a needle-scan similar to `is_system_metadata`, rewraps them as `FeedId::SUPERVISOR_TELEMETRY` frames (same pattern as the SESSION_METADATA rewrap from the Step 6 fix), and broadcasts. The divergence events are not session-scoped — all connected clients see all divergences, by design, because a version drift affects every card on this tugcast instance.

5. **Tugdeck-side surface.** `CodeSessionStore` (or a sibling `StreamJsonTelemetryStore`) subscribes to `SUPERVISOR_TELEMETRY` with no filter. When a drift event arrives, a persistent "⚠ Claude Code version drift" banner appears in the Tide card chrome. Clicking the banner expands an inline report with the divergence `kind`, the raw event payload, the current `claude_version`, and a copy-to-clipboard button for bug reports. The banner is dismissible per-session but re-appears on any new drift event.

**Layer C — Version-adaptive reducer.**

1. **Version capture at session init.** `agent_bridge::relay_session_io`'s atomic-promote block already captures `claude_session_id` from the `session_init` payload. Extend the same critical section to also parse `system_metadata.version` (which arrives on the next event) and store it on `LedgerEntry::claude_version: Option<String>` (new field). The first `system_metadata` after `session_init` is the authoritative version source.

2. **Version propagation to the store.** `CodeSessionStore`'s subscription to `SESSION_STATE` and `SESSION_METADATA` lets it observe the version on session init. Cache it in a new `session_version` snapshot field. Expose it in the store's public API so tide-card components can display it (e.g., "Claude 2.1.104" in the chrome).

3. **Version-banded reducer switch.** When a version bump introduces a field shape change that the drift test flagged, the reducer adds a switch-case:
   ```ts
   function reduceAssistantText(state, event, version) {
     // Version-banded shim: 2.2.x renamed `text` to `content`.
     const text = version.startsWith("2.2.")
       ? event.content
       : event.text;
     return { ...state, streamingText: state.streamingText + text };
   }
   ```
   Most reducer cases will stay version-agnostic; the version switch is reserved for actual shape changes. The golden fixtures under `fixtures/stream-json-catalog/v<version>/` are the authoritative reference for which fields exist per version.

4. **New-version workflow.** When a new Claude Code version ships:
   - Developer runs `TUG_REAL_CLAUDE=1 cargo test --test capture_stream_json_catalog -- --ignored`.
   - Capture binary writes fixtures to `fixtures/stream-json-catalog/v<new-version>/`.
   - Developer reviews the diff against the previous version's fixtures.
   - If shapes are identical: commit the new fixtures, done.
   - If shapes differ: update the reducer's version-band switch, update `transport-exploration.md`'s version banner with the delta, add a regression test that asserts the specific drift is handled, commit everything as one atomic version-bump PR.
   - The drift test then passes for both the old and new version.

5. **Feature-flag escape hatch.** A `CodeSessionConfig::claude_version_override: string | null` field (default `null`) lets a user or test force the reducer to a specific version band regardless of what `system_metadata` reports. Primary use: "Claude 2.3 broke the shape, downgrade my parser to 2.2 while I report the bug upstream" — a temporary user-side fallback. Secondary use: reducer unit tests drive the store with a fabricated version to exercise specific branches.

**Scope:**

- `tugcast-core/src/protocol.rs` — add `FeedId::SUPERVISOR_TELEMETRY = 0x53`; update `FeedId::name()`; update the known-FeedId golden byte test.
- `tugdeck/src/protocol.ts` — mirror `FEED_ID_SUPERVISOR_TELEMETRY = 0x53` constant.
- `tugcast/src/feeds/agent_supervisor.rs` — add `telemetry_tx: broadcast::Sender<Frame>`; wire into `AgentSupervisor::new` and `main.rs`; extend `LedgerEntry` with `claude_version: Option<String>`.
- `tugcast/src/feeds/agent_bridge.rs` — capture `system_metadata.version` in the atomic-promote block (alongside `claude_session_id`); needle-scan for `stream_json_divergence` in the merger and retag as `FeedId::SUPERVISOR_TELEMETRY`.
- `tugcast/src/main.rs` — `register_stream(FeedId::SUPERVISOR_TELEMETRY, telemetry_tx, LagPolicy::Warn)`.
- `tugcode/src/ipc.ts` — replace silent `console.error` in `isInboundMessage` with `writeDivergence` helper that emits structured stdout event.
- `tugcode/src/types.ts` — add outbound `StreamJsonDivergence` event type to the outbound union.
- `tugdeck/src/lib/code-session-store.ts` (already existing by this point) — version capture from SESSION_METADATA, version-adaptive reducer scaffold, `claude_version_override` config field.
- `tugdeck/src/lib/stream-json-telemetry-store.ts` (new) — subscribes to `SUPERVISOR_TELEMETRY`, exposes an array of recent divergence events for the drift banner.
- `tugdeck/src/components/tugways/cards/tide-card/drift-banner.tsx` (new) — persistent warning banner with expandable report view.

**Tests:**

- Unit: `CodeSessionStore` reducer branches for a fabricated `claude_version_override`. Assert that the right branch runs for each band.
- Unit: `StreamJsonTelemetryStore` receives a synthetic divergence event and exposes it via `getSnapshot()`.
- Fault injection: modify a golden fixture to introduce a phantom field, run the drift test, assert it fails with a structured diff report citing the phantom field.
- Fault injection: synthesize a stream-json payload with an unknown event type via a test-only spawner, assert tugcode emits a `stream_json_divergence` event and the supervisor retags it to `SUPERVISOR_TELEMETRY`.
- Real-Claude integration: `test_version_capture_on_session_init` — drives a live session, asserts `LedgerEntry::claude_version` is populated after session_init, asserts the value matches `system_metadata.version` from the stream.
- Real-Claude integration: `test_unknown_event_type_surfaces_as_divergence` — installs a stub claude that emits a crafted unknown event, asserts the supervisor telemetry broadcast delivers a `stream_json_divergence` frame to a subscribed client.

**Schedule:** Lands after T3.4.a's first working version. Layer C's version-adaptive reducer scaffold is informed by what fields `CodeSessionStore` actually depends on, which is only legible once the store exists. T3.4.b/c/d can proceed in parallel with P15 once T3.4.a is in.

#### P16: `session_command: continue` through multi-session router (HIGH) {#p16-session-command-continue}

**Problem:** The `session_command: continue` message, sent via tugcast's `CODE_INPUT` feed to a per-session tugcode worker, does not produce a working post-command turn. Discovered during tugplan-golden-stream-json-catalog Step 2 while writing the per-helper round-trip test `test_send_session_command_continue_preserves`:

1. Spawn a session, plant a memory marker via the first turn (`"Remember GAZEBO"`). First turn completes normally.
2. Send `session_command: continue` via `TestWs::send_session_command`.
3. Send a probe `user_message` asking which word the model was told to remember.
4. `collect_code_output` for the probe turn times out at 30s — no `turn_complete` arrives.

Stderr shows `[tugcode] Plugin dir:` appearing twice within a single session lifetime, suggesting tugcode re-spawns its claude child on `continue` (likely with `--resume <session_id>`). From tugcast's side the bridge worker's stdin/stdout are the same tugcode pipes, so the new claude's events should flow back through. Something in that handoff — either tugcode's own state tracking across the respawn, or a mismatched session-id on the user_message, or claude rejecting the replayed message — stalls the probe turn.

Per transport-exploration.md Test 17 (captured via the legacy direct-tugtalk probe), `continue` was "seamless, in-place, no process kill." The multi-session router path may be exposing a real tugcode bug that the direct probe path didn't, **or** the router is mishandling the frame in a way the direct probe sidestepped, **or** `claude 2.1.104` handles `continue` differently than `2.1.87`. All three are plausible; diagnosis requires instrumenting tugcode's session_command handler and comparing its post-continue state to a known-good direct-probe capture.

**Evidence:**
- `test_send_session_command_continue_preserves` was deleted from `tests/multi_session_real_claude.rs` in the Step 2 commit (log: "surfaced a tugcode/supervisor bug on the `continue` path").
- `test_send_session_command_new_respawns` (the `new` variant) passes — the `send_session_command` helper itself is sound; the bug is specific to `continue`.

**Fix:**
- Instrument tugcode's session_command handler to log the exact sequence of actions on `continue` (kill? respawn? `--resume`? preserve pipes?).
- Reproduce via direct tugtalk probe against `claude 2.1.104` and compare against the multi-session router path.
- If the bug is in tugcode: fix tugcode's state tracking.
- If the bug is in the multi-session router: extend Step 2's opaque pass-through audit to cover the specific continue handoff pattern.
- Re-enable `test_send_session_command_continue_preserves` (or a minimal equivalent) and land a Step 6 drift probe for session_command: continue end-to-end.

**Scope:** `tugcode/src/session.ts` (likely), `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` (possibly), `tugrust/crates/tugcast/tests/multi_session_real_claude.rs` (restoration).

**Schedule:** **Deferred past Step 4.** The Step 4 canary confirmed this symptom extends to probes 13 (`session_command: new`), 17 (`continue`), and 20 (`fork`) — all three fail inside the multi-session router with `Connection reset without closing handshake` at ~45 000 ms, which is a sibling symptom of [P19](#p19-45s-ws-reset). They ship as `skipped` in the initial `v2.1.104/` baseline (manifest.json carries the pointer). Fix is still required before Step 6 ships the drift regression test — the drift test must either run probes 13/17/20 or explicitly skip them the same way the baseline does.

#### P17: `model_change` synthetic confirmation shape drift (LOW) {#p17-model-change-confirmation-shape}

**Problem:** `transport-exploration.md` Test 16 (captured via the legacy direct-tugtalk probe against `claude 2.1.87`) documented that `model_change` produces a synthetic `assistant_text` with the literal text `"Set model to <model>"`. Through the tugcast multi-session router path against `claude 2.1.104`, no such `assistant_text` arrives — the `test_send_model_change_synthetic_confirmation` test (written from the prose) timed out after 30s waiting for that event type.

The `send_model_change` helper itself is sound: `test_send_model_change_behavioral` (the replacement test, which probes "what model are you?" after the change and asserts "sonnet" in the response) passes. The model change takes effect; only the confirmation event's shape differs from the prose.

**Why LOW:** This is exactly the class of drift the P2-follow-up golden catalog is designed to catch, and it's informational (behavioral functionality intact). The right fix is to capture `v2.1.104/` fixtures in Step 4 and let them be the ground truth for `model_change`'s observable event sequence. The prose is then downgraded as expected.

**Fix:**
- Step 4 baseline capture records whatever events `model_change` actually produces against `claude 2.1.104`.
- Step 5 "Known divergences from prose catalog" section notes the delta from Test 16's prose.
- No code change needed in tugcast or tugcode.

**Scope:** `dash/transport-exploration.md` (known-divergences section, updated in Step 5).

**Schedule:** Self-resolves during tugplan-golden-stream-json-catalog Step 4 + Step 5. No separate landing required.

#### P19: 45s WebSocket reset on long-running capture probes (RESOLVED) {#p19-45s-ws-reset}

**Status:** RESOLVED 2026-04-13. TestWs now implements the client side of the heartbeat protocol.

**Problem:** During tugplan-golden-stream-json-catalog Step 4's `TUG_STABILITY=1` canary run, six distinct probes — test-10 (long streaming 300 words), test-13/17/20 (session-command new/continue/fork), test-25 (`/tugplug:plan` invocation), test-35 (AskUserQuestion flow) — all failed with the **identical** error signature:

```
ws recv error: WebSocket protocol error: Connection reset without closing handshake
```

at runtimes clustered between 45055 ms and 45110 ms. That's a 55-ms spread across six unrelated probes, against their own timeouts of 45/60/90/120/180 s.

**Root cause:** tugcast's router enforces a bidirectional application-level heartbeat. From `tugrust/crates/tugcast/src/router.rs`:

```rust
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT:  Duration = Duration::from_secs(45);
```

The router sends a `FeedId::HEARTBEAT` frame every 15 s and expects the client to send one back. When a client heartbeat arrives, `last_heartbeat = Instant::now()` is reset (router.rs:815-818). On every 15 s server tick, if `last_heartbeat.elapsed() > HEARTBEAT_TIMEOUT`, the router calls `teardown_client()` and drops the socket without a close frame — observable to a passive client as `Connection reset without closing handshake` at ~45 055 ms (router.rs:919-931). This is the *correct* behavior — TCP ACKs are invisible at the app layer, so the server needs active client liveness proof in case the client is frozen (crashed tab, dead process) with the socket still open at kernel level.

**Why six probes, not thirty:** the browser client in `tugdeck/src/connection.ts:397-401` correctly implements the client side via `this.send(FeedId.HEARTBEAT, ...)` on a 15 s `setInterval`. The `TestWs` test harness in `tugrust/crates/tugcast/tests/common/mod.rs` did not — it opened a socket, sent one CODE_INPUT frame, then passively drained CODE_OUTPUT frames. After 45 s of client-side silence, the server killed every test session whose response tail ran past the ceiling. The six failing probes are the ones whose collect phase exceeded 45 s; the 29 passing probes all happen to complete under it.

**Fix:** Split `WsStream` via `StreamExt::split()` into a `SplitSink` + `SplitStream`, wrap the sink in `Arc<tokio::sync::Mutex<_>>` so both test-driven sends and a background task can share it, and spawn a heartbeat task in `TestWs::connect` that sends a `Frame::heartbeat()` every 15 s for the lifetime of the socket. The task is aborted in `impl Drop for TestWs` so a TestWs that outlives its TestTugcast does not leak a tokio task. All ten send helpers on `TestWs` now route through `self.sink.lock().await.send(...)`; the three recv sites use `self.stream.next()`.

No tugcast or tokio-tungstenite change — the 45 s ceiling itself is correct. The bug was that `TestWs` was a dead client by design.

**Regression guard:** `test_heartbeat_survives_long_turn` in `tugrust/crates/tugcast/tests/multi_session_real_claude.rs`. Asks claude for "exactly 300 words about the history of the internet" (the same prompt as `test-10-long-streaming-300-words`) and asserts `turn_complete` arrives. Empirical runtime on the resolved branch: **51.37 s**, well past the 45 s ceiling, with 62 CODE_OUTPUT frames collected. Without the heartbeat task this test would fail identically to the Step 4 canary — `Connection reset without closing handshake` at ~45 055 ms.

**Test isolation — real-claude tests now feature-gated:** during the P19 landing it became clear that the real-claude test binaries were enumerated (and in `#[ignore]` "skipped" state) in every standard `cargo nextest run -p tugcast` invocation. That made the signal-to-noise ratio in the default test output poor and left a sharp-edge footgun for anyone running `--run-ignored only` without a `TUG_REAL_CLAUDE=1` environment. The P19 landing added a `real-claude-tests` Cargo feature in `tugrust/crates/tugcast/Cargo.toml` and gates the three real-claude test surfaces behind it:

- `multi_session_real_claude.rs` has `required-features = ["real-claude-tests"]` on its `[[test]]` entry, so Cargo does not even compile the test binary in standard mode.
- `capture_stream_json_catalog.rs` and `stream_json_catalog_drift.rs` keep their unit test modules unconditional, but the `capture_all_probes` / `stream_json_catalog_drift_regression` async test functions and their real-claude-only helpers are wrapped in `#[cfg(feature = "real-claude-tests")]`. Default `cargo nextest list -p tugcast` returns three binaries (`bin/tugcast`, `capture_stream_json_catalog`, `stream_json_catalog_drift`) and lists none of the real-claude test function names.
- On-demand invocation: `cargo test -p tugcast --features real-claude-tests --test <name> -- --ignored` (with `TUG_REAL_CLAUDE=1` set) remains the canonical way to run one of these tests against a real Claude Code binary.

The `#[ignore]` attribute and the `require_real_claude!()` env-var guard remain as belt-and-suspenders inside each test body.

**Probe re-enablement:** the un-skip experiment was partially successful — the heartbeat fix cleared P19 on all three probes that had been blocked only on it, but un-skipping the two follow-on probes also surfaced two distinct non-P19 issues.

- **Un-skipped (validated):** `test-10-long-streaming-300-words`. Captures cleanly in ~54 s after the heartbeat fix — exactly the probe that used to trip the 45 s ceiling.
- **Re-skipped with new reasons (follow-on work):**
  - `test-25-tugplug-plan-invocation`: the probe script sends `/tugplug:plan` but never answers the clarifying questions the orchestrator produces via AskUserQuestion, so the skill hangs until the 180 s timeout. Probe-design issue, not a heartbeat one. `skip_reason` updated to *"probe script incomplete — /tugplug:plan asks clarifying questions the script never answers; needs redesign (not P19)"*.
  - `test-35-askuserquestion-flow`: at `TUG_STABILITY>=2` the first capture run returns 0 events in ~90 s (below both the 180 s timeout and the 90 s `WaitForEvent control_request_forward` budget) while subsequent runs capture the full 27-event sequence. The socket does not reset — the probe exits cleanly with no events. Likely a tugplug-side cold-start effect. `skip_reason` updated to *"first-run flake at stability>=2 — probe returns 0 events intermittently; needs root-cause investigation separate from P19"*.
- **Still skipped on P16:** test-13 (session-command-new), test-17 (session-command-continue), test-20 (session-command-fork). These remain blocked on [P16](#p16-session-command-routing) — the multi-session router hangs on the post-command probe turn regardless of heartbeat.

**Baseline re-capture required:** the v2.1.105 golden fixtures under `tests/fixtures/stream-json-catalog/v2.1.105/` were captured when test-10 was still marked as P19-blocked, so `test-10-long-streaming-300-words.jsonl` is empty and the `schema.json` has no canonical sequence for it. After un-skipping test-10, the baseline must be re-captured at `TUG_STABILITY=1` to populate that probe's fixture and refresh `manifest.json` + `schema.json`. The earlier session-internal re-capture (stability=1) completed in 148 s with 30 passed, 5 skipped, 0 failed, 0 unstable — a clean outcome that should be reproducible.

**Drift-test follow-on:** when the drift regression test is re-run against the refreshed v2.1.105 baseline, expect it to surface ~1 fail + ~2 warn findings caused by claude 2.1.105's non-deterministic emission of `thinking_text` and leading `assistant_text` ("Let me check…" preamble). These are *not* P19 regressions — they're a separate over-strictness in `diff_probe_sequence` that the prior baseline's "2 Warn 0 Fail" landing happened to miss by luck (with ~30 probes at ~90 % per-probe stability, the odds of a fully-clean drift run are ~0.9^30 ≈ 4 %). Tracked as a follow-on to P19; fix is to teach the differ to tolerate optional-slot events (slot-set comparison or LCS gap analysis) without loosening strictness for structural events.

**Scope of fix (landed):**
- `tugrust/crates/tugcast/tests/common/mod.rs` (TestWs split + heartbeat task + Drop impl).
- `tugrust/crates/tugcast/tests/multi_session_real_claude.rs` (new `test_heartbeat_survives_long_turn` regression test).
- `tugrust/crates/tugcast/tests/common/probes.rs` (un-skip test-10, re-skip test-25/35 with new reasons).
- `tugrust/crates/tugcast/Cargo.toml` + `tests/capture_stream_json_catalog.rs` + `tests/stream_json_catalog_drift.rs` (real-claude test feature gating so `cargo nextest run` no longer enumerates them).
- `dash/tide.md` (this entry + Phases summary).

#### P20: Claude 2.1.105 `rate_limit_event` dropped by tugcode router (MEDIUM) {#p20-rate-limit-event-dropped}

**Problem:** During tugplan-golden-stream-json-catalog Step 6's drift regression run and subsequent v2.1.105 baseline capture, every real-claude probe logged `[tugcode] Unhandled top-level event type=rate_limit_event` once (sometimes more) while claude's stream-json output was being relayed. The event is emitted by `claude 2.1.105` at the upstream level but tugcode's `routeTopLevelEvent` in `tugcode/src/session.ts` has no handler for it, so it is dropped before ever reaching tugcast's `CODE_OUTPUT` feed. `CodeSessionStore` therefore never sees it.

This is structurally the same class of bug as the `api_retry` drop documented in `dash/transport-exploration.md` — claude adds a new top-level `system`-style event, tugcode's allowlist doesn't include it, the event silently vanishes.

**Why MEDIUM:** Unlike `api_retry`, `rate_limit_event` is believed to be a subscription-tier rate-limit signal that users will actually want to see in the UI (so they know when they're about to hit a rate cap). Until it's routed, any future tugdeck rate-limit banner or tugapp rate-limit indicator will be working blind. Not a drift-test failure — the drift test's probes never see the event because it's filtered at the tugcode layer, so there's no shape to pin — but it is a real transport gap.

**Evidence:**
- Step 6 drift verify run (2026-04-13): `[tugcode] Unhandled top-level event type=rate_limit_event` appeared in `/tmp/drift-verify2.log` for ~25 of 29 non-skipped probes across a single 122.7 s real-claude run. Frequency suggests claude is emitting it as a metadata sidecar on most turns, not as a threshold alert.
- Not present in the v2.1.104 fixtures (the drift test against 2.1.104 → 2.1.105 would have surfaced it as a new event type otherwise). Matches the Step 6 "Known divergences" table entry for 2.1.105 additions.
- `test_subscription_auth_source` (from commit `e437c423`) also observed `[tugcode] Unhandled top-level event type=rate_limit_event` in its `/status` round-trip — confirms the event fires regardless of tool use, slash commands, or turn length.

**Fix:**
1. Add a `rate_limit_event` case to `routeTopLevelEvent` in `tugcode/src/session.ts`, mirroring the `api_retry` forwarding that transport-exploration.md's Phase 2 work list already specifies.
2. Choose an outbound shape: either forward the raw `rate_limit_event` payload under a new outbound event type (e.g., `rate_limit_event` with whatever fields claude ships), or map it into the existing `system` event family with a `subtype` discriminator.
3. Add a capture probe that asks claude to produce a rate-limit sidecar (trivial — any prompt seems to do it on 2.1.105) and pin the event shape in the golden catalog.
4. Tugdeck/tugapp UI work to surface the rate-limit state is follow-on.

**Scope:** `tugcode/src/session.ts` (1-line allowlist extension + shape translation), new probe in `tugrust/crates/tugcast/tests/common/probes.rs`, golden catalog re-capture after the tugcode change lands. Optionally: a `dash/transport-exploration.md` known-divergences update to document the new event.

**Schedule:** Not a Step 8 blocker. P20 fix can land after the tugplan-golden-stream-json-catalog closes, as its own focused change with an atomic tugcode + fixture + probe commit. When it lands, re-run the version-bump runbook in `tests/fixtures/stream-json-catalog/README.md` to re-capture whichever version is current at that time.

#### P8: Auth for remote use (LOW)

**Problem:** Session cookie + origin validation for localhost only. The "remote use comes for free" architecture works at the transport level, but auth doesn't survive network deployment.

**Fix:** Add a token-based auth mode alongside the existing cookie mode:
1. Server generates a long-lived API token (stored in tugbank).
2. Client sends token via `Authorization: Bearer TOKEN` header on WebSocket upgrade.
3. Server validates token. No origin check in token mode (the token IS the credential).
4. Cookie mode remains for local browser use. Token mode enables remote CLIs, scripts, and non-browser clients.

Don't implement TLS in tugcast — run it behind a reverse proxy (nginx, caddy) for HTTPS in remote deployments. The proxy terminates TLS; tugcast sees plain HTTP.

**Scope:** tugcast `auth.rs` (add token validation path), tugbank (store tokens), tugdeck (send token header when configured for remote).

#### P9: Optional compression (LOW)

**Problem:** JSON payloads sent raw. Not a problem on localhost. Matters for remote use.

**Fix:** Add WebSocket `permessage-deflate` support. The `tokio-tungstenite` crate supports this as a configuration option on the WebSocket upgrade. No changes to the frame format — compression is transparent at the WebSocket layer.

Enable by default. Disable via flag if CPU overhead is a concern on low-power devices.

**Scope:** tugcast `server.rs` (WebSocket upgrade configuration). Small change.

#### P10: Feed subscription filtering (LOW)

**Problem:** All snapshot feeds go to all clients. No per-client filtering.

**Fix:** Add an optional subscription message after the protocol handshake: `{"type":"subscribe","feeds":[0x20,0x40]}`. If sent, the router only forwards snapshots for the listed FeedIds. If not sent, all feeds are forwarded (backward compatible).

This becomes useful when specialized clients (e.g., a CLI tool that only cares about CodeOutput, or a monitoring dashboard that only wants Stats) connect and don't want irrelevant traffic.

**Scope:** Router `handle_client` (filter snapshot list based on subscription), protocol (new message type).

#### P11: Generalized bootstrap / lag recovery (LOW)

**Problem:** The BOOTSTRAP state captures tmux pane content. This is terminal-specific. Tugshell won't have a tmux pane; its "current state" is different (last command output, cwd, environment). Each backend may need its own bootstrap strategy.

**Fix:** Make bootstrap a per-backend concern, not a router concern. When the router detects lag on a stream feed:
1. Send a `lag_detected` control frame to the client with the FeedId that lagged.
2. The client requests a bootstrap: `{"type":"bootstrap_request","feed_id":0x00}`.
3. The router forwards the request to the backend.
4. The backend sends its bootstrap data (terminal: captured pane; shell: last N command results; code: recent event buffer from P4).

The router doesn't know what bootstrap means for each backend — it just brokers the request. The backend decides what to send.

**Scope:** Router (replace terminal-specific BOOTSTRAP with generic lag_detected + bootstrap_request), agent bridge (implement code bootstrap from P4 buffer), terminal feed (refactor current bootstrap into the new pattern). Tugshell implements its own bootstrap in Phase T4.

**Work order:**

The fixes have dependencies. Organized into dashes:

**Dash 1A — Protocol foundation (wire format, types, handshake):**

1. **P1** (open FeedId) — newtype struct, unblocks everything
2. **P7** (raise max payload) — trivial constant change, do alongside P1
3. **P3** (FeedId collision) — fix slot assignments, add Shell/TugFeed constants
4. **P12** (flags byte) — expand header 5→6 bytes, data/control bit
5. **P6** (protocol version handshake) — document as v1, handshake on connect

**Dash 1B — Dynamic router (the big rewrite):**

6. **P2** (dynamic router) — `StreamMap` fan-in, `HashMap<FeedId, Sender>` input dispatch, router-internal handling for Control/Heartbeat

**Dash 2 — Robustness (depends on P2):**

7. **P4** (CodeOutput lag recovery) — ring buffer, replay, uses P12 flags for control frames
8. **P11** (generalized bootstrap) — per-backend bootstrap, uses P12 flags
9. **P5** (multi-client input guard) — single-writer-per-FeedId enforcement

**Dash 3 — Polish (all deferred):**

10. ~~**P9** (compression)~~ — deferred; `permessage-deflate` not available in tungstenite 0.28/axum 0.8 stack. Revisit when remote use is on the horizon or if tungstenite restores the feature.
11. ~~**P8** (remote auth)~~ — deferred until remote use is on the horizon
12. ~~**P10** (subscription filtering)~~ — deferred until remote use is on the horizon

**Exit criteria:**
- [x] Wire format is v1: `[FeedId:1][flags:1][length:4][payload:N]`, documented
- [x] `FeedId` is an open `u8` newtype; unknown bytes don't produce errors
- [x] Protocol handshake on WebSocket connect; version and capabilities negotiated
- [x] Router dispatches input frames via dynamic map lookup, not hardcoded fields
- [x] Adding a new backend is: register channel pair by FeedId, spawn bridge process. No router code changes.
- [x] CodeOutput lag triggers replay from ring buffer, not silent event loss
- [x] Multi-client input guarded: first writer claims, others get error
- [x] Max payload raised to 16 MB
- [x] FeedId slot assignments corrected (Defaults=0x50, Shell=0x60/0x61, TugFeed=0x70)
- [x] `cargo build && cargo nextest run` pass (912 Rust tests, 1782 TypeScript tests)
- [ ] End-to-end verification pending (tugdeck + tugcast live session)
- P8 (remote auth), P9 (compression), and P10 (subscription filtering) deferred — not needed for local Tide development path

---

### Phase T3: Prefix Router + Prompt Input {#prefix-router-prompt-input}

**Goal:** The unified command input — where every interaction begins. A rich prompt surface with inline atoms, prefix routing, typeahead completions, and history. Combines the prompt input layer (formerly Phase 4) with the prefix routing system. Addresses U12, U13, U19 from tug-conversation.md.

**Rationale for ordering:** T3 comes first because the input surface is needed to test everything downstream. Without a prompt, you can't send a `>` message to Claude Code (needed to test T1 rendering) or a `$` command to a shell (needed to test T4). T1 rendering with only mock/gallery data is synthetic; T3 makes it real.

**Components built in this phase:**

| Component | Kind | Description |
|-----------|------|-------------|
| tug-atom | Original | Inline token: resolved file, slash command, or doc reference. Icon + label, deletable as a unit. Draggable from Finder. Shipped in T3.1/T3.2 as `<img>` atoms with `data-atom-*` attributes. |
| tug-prompt-input | Original | Rich input field with atoms, first-character **route atoms** (`>`, `$`, `:`, `/`), `@` and `/` completion providers, history navigation, IME, undo/redo, drag-and-drop, maximize mode, and tugbank persistence [L23]. |
| tug-prompt-entry | Composition | Composes tug-prompt-input + route indicator (tug-choice-group) + submit/stop button. Turn state and all dispatch logic come from **CodeSessionStore** via `useSyncExternalStore`; the component itself is tokenable and free of business logic. |
| SessionMetadataStore | Store (L02) | Subscribes to **`SESSION_METADATA` (0x51)** snapshot feed. Provides slash commands (local), skills, model, cwd, permission mode. Late subscribers receive current state via watch channel — see [session-metadata-feed.md](session-metadata-feed.md). |
| PromptHistoryStore | Store (L02) | Per-route, per-card submission history. **Current implementation uses IndexedDB — that's a wart we intend to remove in favor of a tugbank-backed rewrite per D-T3-10. The existing IndexedDB dependency is tabled, not blocking; no new IndexedDB usage is permitted.** `HistoryProvider` consumed directly by tug-prompt-input. |
| CodeSessionStore | Store (L02) | **New in T3.4.a.** Per-card, keyed by a `sessionKey` per D-T3-09. Subscribes to `CODE_OUTPUT` (0x40) via `FeedStore` with a session-ID filter, owns the prompt→turn state machine, accumulates streaming deltas into a per-card `PropertyStore` path for `TugMarkdownView`, and exposes `send(text, atoms, route)` / `interrupt()` / `respondApproval()` / `respondQuestion()` — each serializing the corresponding payload onto `CODE_INPUT` (0x41) tagged with the session_id. |
| Tide card | Card registration | **New in T3.4.c.** `registerTideCard()` — `TugSplitPane` (horizontal) with `TugMarkdownView` on top bound to `CodeSessionStore` streaming region, `TugPromptEntry` on bottom. Default feeds: `[CODE_INPUT, CODE_OUTPUT, SESSION_METADATA, FILETREE]`. The functional peer of `git-card`. One `CodeSessionStore` per Tide card instance (D-T3-09). |

**Design decisions:**

- **D-T3-01: Route selection.** Three routes: `>` (Claude Code), `$` (Shell), `:` (Surface built-ins). Route is set by either (a) typing the prefix character as the first character of input, or (b) clicking the route indicator (tug-choice-group in tug-prompt-entry). The two are bidirectionally synced. `/` as first character is an implicit `>` (slash command mode). No "default" route — the route indicator always shows the active route, and the user explicitly selects it.
- **D-T3-02: `@` is route-independent.** Typing `@` anywhere in any route triggers file completion. The `@` trigger may also offer doc links in the future.
- **D-T3-03: Atoms.** Inline token pills embedded in the text stream (like Apple Mail address tokens or Cursor file references). An atom is inserted when a completion resolves (e.g., `@file` tab-completes to a file atom pill). Atoms are atomic — backspace deletes the whole pill. Atoms can be inserted via drag-and-drop (files from Finder). Atoms contribute structured data to the submitted message (file paths, slash command names) separately from the plain text.
- **D-T3-04: The first consumer of tug-prompt-entry is the functional Tide card, not a gallery card.** tug-prompt-input already has its own gallery card (isolated input testing). A second gallery card for tug-prompt-entry would require a mock turn-state environment that differs from the live `CODE_OUTPUT` / `CODE_INPUT` wire protocol — exactly the "tests must match user reality" trap. The Tide card is the testbed. Component-level tests live as Vitest suites against a mock `CodeSessionStore`, not a rendered gallery.
- **D-T3-05: Turn state lives in a store, not the component.** `CodeSessionStore` owns the state machine (phases: `idle → submitting → awaiting_first_token → streaming → tool_work → (awaiting_approval) → complete | interrupted | errored → idle`). tug-prompt-entry reads the snapshot and renders CSS-token-driven states per [L06]/[L15]. This keeps the component pure, lets future alternate input surfaces share one source of truth, and makes integration tests a matter of driving the store.
- **D-T3-06: Submit is the interrupt button.** When `CodeSessionStore.canInterrupt === true`, the submit control flips to "Stop" and dispatches `{ type: "interrupt" }` on `CODE_INPUT`. Per transport-exploration.md Test 6, interrupt produces `turn_complete(result: "error")` with the accumulated text preserved — the store consumes this as the `interrupted → idle` transition.
- **D-T3-07: Message queueing during turn (U19).** Sending a `user_message` mid-stream does not interrupt Claude Code — it queues. The store mirrors this: while `phase !== idle` and `phase !== complete`, submit enqueues locally and the UI shows a pending-queue indicator. The store flushes the queue to `CODE_INPUT` in order on `idle`. Interrupt drains the queue.
- **D-T3-08: `control_request_forward` is a single gate event.** Per transport-exploration.md Test 8/11, permission prompts and `AskUserQuestion` are both `control_request_forward`, differentiated by `is_question`. The store exposes `pendingApproval` / `pendingQuestion` on its snapshot and `respondApproval({ decision, updatedInput?, message? })` / `respondQuestion({ answers })`. T3.4 renders the approval/question UI inside the Tide card's output pane (as block-level content), not inside tug-prompt-entry — the entry stays a composition surface, not a dialog host.
- **D-T3-09: Tide card ↔ CodeSessionStore is 1:1; one session per card.** Each Tide card owns its own `CodeSessionStore`, keyed by a per-card `sessionKey` that matches the `session_id` assigned by the backing tugtalk. This mirrors terminal semantics — opening a second terminal window gives you a second `claude` subprocess with a separate session — and is the foundation for running multiple independent conversations side by side. The store API is session-scoped from day one (the constructor takes `sessionKey`; inbound frames are filtered by session_id; outbound frames are tagged with it). The multi-session wire protocol (session_id embedded in `CODE_OUTPUT` / `CODE_INPUT` payloads, routed via a dynamic tugtalk supervisor) is **Phase T0.5 P2**, which is the next work item after the current state and is a hard blocker on any follow-on TIDE: INPUT progress that requires genuine multi-session behavior. T3.4.a/b/c can be built against this contract today; T3.4.d's multi-session exit criteria are gated on P2.
- **D-T3-10: Prompt history does not depend on IndexedDB — tugbank is the persistence engine.** All new client-side persistence in tugdeck goes through tugbank (SQLite). The current `PromptHistoryStore` implementation is IndexedDB-backed; that is a wart inherited from T3.3 and will be rewritten to a tugbank-backed form in a follow-up (new `dev.tugtool.tugways.prompt-history` domain, typed API in `settings-api.ts`, L02 store as a write-through in-memory recent window over the persisted collection). **The rewrite is tabled, not urgent — but no new IndexedDB dependencies are permitted anywhere in tugdeck from here forward.** If a T3.4 sub-step would otherwise reach for IndexedDB, it goes through tugbank instead.
- **D-T3-11: Stores do not persist their own observed state — they rehydrate from feeds.** The division is: (a) **feed infrastructure** (snapshot feeds via `watch::channel`, broadcast replay buffers, Phase T0.5 P4 lag recovery) is how derived/observed state comes back after a reload or reconnect; (b) **tugbank** is how mutable state the store itself writes (prompt drafts via L23, prompt history, split-pane layouts, card state) persists. In concrete terms: `SessionMetadataStore` and `FileTreeStore` are in-memory because `SESSION_METADATA` and `FILETREE` are snapshot feeds — late subscribers receive the current state immediately. `CodeSessionStore` is in-memory because `session_init` is watch-channel-promoted and `CODE_OUTPUT` has a replay buffer; long-turn reload recovery beyond the replay window is the Phase T0.5 P4 concern and not a store responsibility. This rule keeps stores thin, prevents duplicated persistence, and makes reconnect semantics the same everywhere.

---

#### Stores, Feeds, and Documents {#stores-feeds-documents}

This phase (T3) establishes the vocabulary we'll use through the rest of Tide. A short forward reference to keep future-us honest.

A **feed** is a tugcast/Rust wire concept. One byte of namespace (`FeedId`), one frame format (`[FeedId][length][payload]`), two delivery shapes (broadcast for streams, `watch::channel` for snapshots). Feeds are defined server-side. They do not know what a React component is.

A **store** is a tugdeck/TypeScript observability primitive. An L02-compliant class (`subscribe(cb)` + `getSnapshot()`) that components read via `useSyncExternalStore`. Stores are thin; they turn feed frames into snapshot objects, or own a state machine that dispatches actions back onto an input feed. Stores live in `tugdeck/src/lib/*.ts` — they are not feeds and they are not bound to a React tree. There is a spectrum of store shapes worth naming:

| Shape | Examples (current / near-term) | What it owns |
|---|---|---|
| **Leaf observer** | `SessionMetadataStore`, `FileTreeStore` | Derived read-only state from a snapshot feed. |
| **Orchestrator** | `CodeSessionStore` (T3.4.a) | A derived state machine + action dispatch back onto an input feed. |
| **Persistence-backed mutable collection** | `PromptHistoryStore` (post-rewrite per D-T3-10) | An in-memory recent window over a tugbank-persisted collection, append/read API. |
| **Document** | Future `TugRichTextDocument`, Monaco-style file-backed editors; `tug-prompt-input`'s L23 buffer is a proto-document today. | A mutable content body + range mutation API + dirty/save lifecycle + a backing URI. Still L02-subscribable — `getSnapshot` returns a content body + version. |

A **document** is a richer subtype of store, not a separate thing. It still exposes `subscribe` + `getSnapshot`; the snapshot just happens to carry editable content. What additionally makes it a document:

1. A content body rich enough to be edited (text engine, Monaco `TextModel`, segment tree, etc.).
2. A mutation API — `insertText`, `deleteRange`, `replaceRange`, plus transactional semantics for undo.
3. A backing URI — the address of the persistent representation: `tugbank://card-XYZ/prompt-draft`, `file:///path/to/README.md`, etc. The URI scheme determines how writes are persisted.
4. A dirty/save lifecycle — modified-since-save, explicit save/revert, conflict detection when the backing store changes underneath.
5. Multi-reader coordination — two cards opening the same URI share one document handle. This is the first place the "per-card store" rule flips to "shared store keyed by URI," and it's orthogonal to the session-per-card rule from D-T3-09.

`tug-prompt-input` is already a proto-document: the engine holds editing state, `captureState` / `restoreState` persists it to tugbank via [L23], scoped to the card. When tug-rich-text lands (deferred, but coming), a formal `DocumentRegistry` keyed by URI becomes the right home for the pattern: cards call `documentRegistry.open(uri)` to get a shared handle; closing the last consuming card releases it. The Tide card built in T3.4 does not need any of this — L23 persistence on tug-prompt-input is sufficient — but T3.4 must not *contradict* the future document model. Specifically:

- The per-card `sessionKey` from D-T3-09 is already the right kind of stable address.
- The "stores rehydrate from feeds, mutations persist through tugbank" rule from D-T3-11 is the same rule documents follow.
- The card-owns-its-stores lifetime model is the same lifetime model documents will use, generalized: resources (stores or documents) are opened by cards and released when the last consuming card closes.

---

#### T3.0: Text Model Spike {#t3-text-model-spike}

**Status:** COMPLETE. See [t3-text-model-spike.md](t3-text-model-spike.md) for full findings.

**Goal:** Determine the correct implementation strategy for tug-prompt-input's mixed text+atom model.

**Spike summary:** Tested three approaches in a Component Gallery card:
- **Approach A (Textarea + overlay):** Non-functional. Arrow keys can't navigate past atoms — spatial correspondence between placeholder chars and rendered pills breaks with proportional fonts.
- **Approach B (Thin contentEditable):** Best surface-level result. Japanese IME, VoiceOver, auto-resize, drag-and-drop, and paste all worked. But deep failures: spurious marked text on US keyboard (macOS/WebKit treats contentEditable as active input session), Cmd+A escapes to page, cursor enters atom interior, undo repositions atoms instead of removing them, Enter during IME composition fires submit instead of accepting text, SelectionGuard conflicts with native selection.
- **Approach C (Hidden textarea + rendered div):** Correct architecture but needs proper implementation — no insertion point without a real document model.

**Decision:** Build a proper text input engine (Approach C done right), inspired by UITextInput concepts. contentEditable is used as an **input capture surface only** — not the document model. All three reference implementations (ProseMirror, CodeMirror 6, Lexical — all MIT licensed) converge on this architecture.

**Architecture** (validated by engine-based spike):
1. **Document Model** — `segments: (TextSegment | AtomSegment)[]` with **text-atom-text invariant**: text segments always exist between atoms and at boundaries. Cursor is always in a Text node. Flat offsets as universal position type (text chars = 1, atoms = 1).
2. **Input Capture** — contentEditable div as input device. Normal text typing flows through the browser; MutationObserver reads changes back to model ("let the browser mutate, diff afterward" — CM6 pattern). Everything else (delete, paste, undo, Enter) is intercepted in `keydown`/`beforeinput` and handled via model operations + reconcile.
3. **Selection/Cursor** — Native browser caret. We do NOT render our own cursor. `sel.collapse(node, offset)` positions it. Selection saved/restored as flat offsets across reconciliation (L23). `selectAll` respects first responder (fixed in tug-card.tsx).
4. **Composition (IME)** — `composingIndex` tracks which segment is being composed. Reconciler skips during composition. `compositionEndedAt` timestamp + 100ms window catches the WebKit bug where `compositionend` fires before Enter keydown. `hasMarkedText` exposed in delegate API.
5. **Undo** — Own stack with immutable segment snapshots. `cloneSegments()` before mutations. Merge heuristic: consecutive same-type edits within 300ms. Browser `historyUndo`/`historyRedo` intercepted and redirected.
6. **Return vs Enter** — `e.code === "Enter"` (Return) vs `"NumpadEnter"` (Enter). Independently configurable actions. Shift inverts. `hasMarkedText === true` → key goes to IME.
7. **CSS** — `::selection` re-enabled inside editor; `::highlight(card-selection)` suppressed. `-webkit-user-modify: read-write-plaintext-only` prevents spurious composition markers.

**Two-layer design:**
- **Layer 1 (Engine):** `TugTextEngine` class — segments, reconciler, MutationObserver, composition tracking, undo. Inspired by Lexical (DecoratorNode, composition key) and CM6 (browser mutate + diff, native caret).
- **Layer 2 (API):** `TugTextInputDelegate` interface — UITextInput-inspired: `selectedRange`, `hasMarkedText`, `insertText()`, `insertAtom()`, `deleteBackward()`, `undo()`/`redo()`, Return vs Enter. The contract between engine and component.

**Spike reference:** Gallery card `gallery-text-model-spike.tsx` contains the working engine and diagnostics panel. Preserved until T3.2 replaces it.

---

#### T3.1: tug-atom Component {#t3-atom}

**Goal:** Build the tug-atom component — the inline token. Two rendering paths: React for standalone/gallery use, DOM for engine reconciler.

**Prerequisites:** T3.0 (architecture decision — atoms are U+E100 characters in inline-flex spans, navigable as single characters. See T3.2 atom architecture).

**Governing documents:**
- [Component Authoring Guide](../tuglaws/component-authoring.md) — file structure, TSX/CSS conventions, `@tug-pairings`, `@tug-renders-on`, checklist
- [Token Naming](../tuglaws/token-naming.md) — seven-slot `--tug7-` convention for atom-specific theme tokens
- Laws: [L06] appearance via CSS, [L15] token-driven states, [L16] pairings declared, [L19] component authoring guide

**Work:**

Dual rendering paths:
- **React path**: `<TugAtom type="file" label="src/main.ts" />` — standalone component, used in gallery card and anywhere React owns the DOM (e.g., atom tray, suggestion list)
- **DOM path**: `createAtomDOM(seg: AtomSegment)` — exported function that builds identical DOM imperatively, used by TugTextEngine's reconciler inside contentEditable
- Both paths produce the same DOM structure, same CSS classes (`tug-atom`), same `data-slot`, same accessibility attributes. The CSS is shared.

Component features:
- Compact rectangular token (Apple Mail / Cursor style, not a rounded pill): icon + label
- Atom type is an open string — known types (file, command, doc, image, link) get specific Lucide icons; unknown types get a default. The set grows over time.
- Visual design: squared-off rectangle (`border-radius: 3px`), subtle tinted background with outline border, slightly reduced font size via `--tug-atom-font-scale` CSS custom property (default `0.85em`), baseline-aligned with surrounding text
- Atom data model: `AtomSegment { kind: "atom", type, label, value }` — same type used by the text engine
- Full state set: rest, hover, selected (two-step delete), highlighted (search/typeahead), disabled
- Hover: tooltip shows full `value`; for dismissible atoms, type icon flips to X for mouse-driven deletion
- Dismiss: icon-to-X on hover (React path) or engine's two-step backspace/click-select (DOM path)
- Label formatting: `formatAtomLabel(value, mode)` utility — `"filename"` / `"relative"` / `"absolute"` — caller decides, component just renders
- Accessibility: `role="img"`, `aria-label="${type}: ${label}"`, keyboard-selectable (engine handles navigation)
- Theme tokens: `--tug7-*-atom-*` tokens defined in both theme files (brio.css, harmony.css) per seven-slot convention
- Gallery card for isolated testing of both rendering paths, click-to-select, dismissal, label modes

**Exit criteria:**
- `<TugAtom />` renders correctly in gallery card (React path)
- `createAtomDOM()` produces identical DOM (verified visually in gallery)
- All known atom types visually distinct with appropriate icons; unknown types get default icon
- Tooltip shows full value on hover
- All states render correctly: rest, hover, selected, highlighted, disabled
- Dismiss icon-to-X flip works on hover in React path
- Token-compliant styling: `@tug-pairings` (compact + expanded), `@tug-renders-on` on all foreground rules
- Accessibility: VoiceOver announces atom label
- Conforms to component authoring guide checklist

---

#### T3.2: tug-prompt-input {#t3-prompt-input}

**Goal:** The rich input field. A thin event-handling layer on top of WebKit's native contentEditable, with atoms rendered as `<img>` replaced elements.

**Prerequisites:** T3.0 (architecture validated).

**Architecture:** The browser is the engine. The DOM is the source of truth. No parallel document model, no reconciler, no MutationObserver diffing. Atoms are `<img src="data:image/svg+xml,...">` elements — WebKit handles caret navigation, selection, undo/redo, and IME natively. Our code provides seven focused customizations on top. See [t3-prompt-input-plan.md](t3-prompt-input-plan.md) for full details.

**Governing documents:**
- [Component Authoring Guide](../tuglaws/component-authoring.md) — file structure, TSX/CSS conventions, `@tug-pairings`, `@tug-renders-on`, input value management, checklist
- [Token Naming](../tuglaws/token-naming.md) — seven-slot `--tug7-` convention for prompt-input theme tokens
- Laws: [L01] single mount, [L06] appearance via CSS, [L07] stable refs, [L15] token-driven states, [L16] pairings declared, [L19] component authoring guide

**Work:**

Simplify and reimplement:
- Strip the TugTextEngine down to a thin event-handling layer (~300 lines, not 1800+)
- Remove: segment model, reconciler, MutationObserver, domPosition/flatFromDOM, ZWSP anchors, ce=false infrastructure, arrow key interception for basic navigation
- Atoms as `<img src="data:image/svg+xml,...">` with `data-atom-*` attributes — replaced elements that WebKit handles atomically
- Standard contentEditable — no `-webkit-user-modify: read-write-plaintext-only` (it blocks image insertion via execCommand)
- CSS: suppress CSS Custom Highlights inside editor, re-enable native `::selection` — this prevents selection guard visual artifacts around images
- Line-height: 24px to accommodate 22px atom images without layout shift
- Read API (getText/getAtoms) reads directly from DOM, no parallel model
- Auto-resize: 1 row default, grows to maxRows [L06]
- Return vs Enter: configurable actions via data attributes [L06]. Shift inverts. IME composing → key passes through.
- `::selection` re-enabled, `::highlight(card-selection)` suppressed inside editor

Seven customizations on top of native contentEditable:
1. **Atom creation** — SVG `<img>` elements with canvas-measured text, Lucide icons
2. **Clipboard** — copy/cut preserve atom HTML + plain text; paste detects atom HTML and uses insertHTML
3. **Drag & drop** — files → atom images at drop point via caretRangeFromPoint + insertHTML
4. **Option+Arrow** — clamp word movement at atom boundaries via Range.compareBoundaryPoints
5. **Click on atom** — select entire image via Range.selectNode
6. **Return/Enter** — submit vs newline via data attributes, Shift inverts
7. **Selection guard** — CSS Custom Highlight suppression inside editor

Prefix detection:
- First character `>`, `$`, `:` sets the active route
- `/` as first character implies `>` route (slash command mode)
- Route change emits callback for tug-prompt-entry sync

Typeahead and completion:
- `@` trigger opens file completion; `/` trigger opens command completion
- Completion provider interface: `(query: string) => CompletionItem[]`
- Tab/Enter accepts, Escape cancels, arrow keys navigate popup
- Drag-and-drop files → atoms via configurable drop handler

History:
- Up/down at document boundaries navigate history
- Per-route history from PromptHistoryStore

Persistence:
- Serialize editor innerHTML + cursor position to tugbank [L23]
- Restore on mount. Survives reload, app quit, `just app`.

**Exit criteria:**
- Text input with atoms works: native caret navigation, selection, undo/redo
- Atoms render as `<img>` with SVG: icons, measured text, theme colors
- Auto-resize works (1 row → maxRows)
- Prefix detection correctly identifies route
- `@` file completion and `/` slash command completion work
- Drag-and-drop file → atom works
- Copy/cut/paste preserves atoms (undo-compatible via execCommand)
- Option+Arrow stops at atom boundaries
- History navigation works
- IME composition works correctly (native)
- Return/Enter key configuration works with Shift inversion
- No `-webkit-user-modify: read-write-plaintext-only`
- CSS Custom Highlight suppression prevents selection artifacts
- Token-compliant styling per component authoring guide
- Gallery card with interactive testing surface
- Editing state persists across reload and app restart [L23]

---

#### T3.3: Stores — SessionMetadataStore + PromptHistoryStore {#t3-stores}

**Goal:** The data sources that feed tug-prompt-input's completions and history.

**Prerequisites:** None (can be built in parallel with T3.1).

**Status:** Shipped for the live Tide work, **modulo the PromptHistoryStore IndexedDB wart** (see D-T3-10). The current implementation uses IndexedDB; the tugbank rewrite is tabled but no new IndexedDB dependencies may be added from here forward.

**Work (as built):**

SessionMetadataStore:
- Subscribes to **`SESSION_METADATA` (0x51) snapshot feed** via FeedStore (per [session-metadata-feed.md](session-metadata-feed.md) — the original "subscribe to CODE_OUTPUT" design was reworked once we discovered the replay-buffer race).
- Parses `system_metadata` payloads: `slash_commands[]`, `skills[]`, `model`, `session_id`, `permission_mode`, `cwd`.
- L02: exposes `subscribe` + `getSnapshot` for `useSyncExternalStore`.
- Provides `getCommandCompletionProvider()` — the `/` trigger hooks directly into it.
- In-memory per D-T3-11: rehydrates from the snapshot feed on every (re)connect.

PromptHistoryStore (current, with known wart):
- Per-route, per-card history.
- **Current backing: IndexedDB.** This is a wart per D-T3-10; the tugbank-backed rewrite is tabled and will happen in a follow-up (`dev.tugtool.tugways.prompt-history` domain, typed API in `settings-api.ts`, L02 store as a write-through in-memory recent window). Until then the existing IndexedDB implementation stays put but **nothing new may take an IndexedDB dependency.**
- L02: `subscribe` + `getSnapshot`.
- API: `push(entry)`, `navigate(route, cardId, direction)`, `current(route, cardId)`.
- History entries store the raw text (not atoms — atoms are resolved references, not reproducible).

**Exit criteria:**
- SessionMetadataStore receives and stores metadata from the live `SESSION_METADATA` feed (shipped).
- PromptHistoryStore persists history across reloads (shipped; IndexedDB, to be rewritten per D-T3-10).
- Both stores are L02 compliant (shipped).
- Unit tests for both (shipped).
- **Follow-up (not blocking T3.4):** Rewrite PromptHistoryStore onto tugbank, delete IndexedDB code, remove the dependency from tugdeck.

---

#### T3.0.W: Workspace Registry Refactor — multi-workspace tugcast {#t3-workspace-registry}

**Goal:** Decouple tugcast from any single, launch-time project directory. Each Tide card (equivalently, each `tug_session_id`) carries its own project path on the wire, and tugcast creates a per-workspace bundle of file-watching + filesystem + filetree + git feeds keyed by canonical project path. Tugcast's own source-tree needs (finding `tugdeck/dist`, `tugcode/src/main.ts`, `target/` for build status) are cleanly separated from "the project a session is working on" so there is no lingering conflation.

**Why this phase exists (and why it blocks T3.4.a):** The multi-session router (Phase T0.5 [P2](#p2-integration-reference)) already landed: N sessions, N tugcode subprocesses, N Claude processes, per-session ledger entries, client-side filter subscriptions. The remaining bottleneck is that every spawn points at the same `project_dir` because `AgentSupervisorConfig::project_dir` is a single `PathBuf` cloned into the spawner factory at startup, and tugcast's `FileWatcher` / `FilesystemFeed` / `FileTreeFeed` / `GitFeed` are constructed once at startup against that same path. If T3.4.a proceeds without fixing this, "per-card workspaces" becomes an aspiration the plan hedges on instead of a real property the system exhibits. T3.0.W is the fix, split into three landable steps.

**Three identifiers, three jobs — the model after T3.0.W:** Today "session" is overloaded. The post-T3.0.W world has three distinct fields with non-overlapping roles:

| Field | Lifetime | Origin | Role |
|---|---|---|---|
| `tug_session_id` | per session | minted client-side via `crypto.randomUUID()` at card mount ([§P2 integration reference](#p2-integration-reference), tide.md:1117) | **Wire routing key.** Spliced into every `CODE_OUTPUT` / `CODE_INPUT` / `SESSION_STATE` / `SESSION_METADATA` frame. Carried in every CONTROL session action. Used as the subscription filter by per-card `FeedStore`s. |
| `claude_session_id` | per session | emitted by Claude Code in the `session_init` event | **Resume key.** Captured into `LedgerEntry::claude_session_id` and (post-[P14](#p14-claude-code-resume-for-persistent-session-history-high)) persisted so `--resume` can restore history across restart. Invisible to routing. |
| `project_dir` | per session | client-chosen at card-open time, shipped on `spawn_session` CONTROL (new in W2) | **Workspace key and Claude cwd.** Canonicalized by the supervisor, used as the key into `WorkspaceRegistry`, handed to `TugcodeSpawner` as the `--dir` arg so Claude's cwd matches the workspace root. Echoed back as `system_metadata.cwd` in the stream — match-by-construction. |

And `sessionKey` on the T3.4.a store becomes a **purely human-facing display label** — the user picks something readable (defaulting to the basename of `project_dir` at card-open time) and can rename it freely. It never hits the wire, never affects routing, and has zero machinery coupling. That's the whole point of splitting it out from the three fields above.

**Scope boundaries:**
- **In scope for T3.0.W:** workspace registry, per-session `project_dir` on the wire, per-workspace feed bundles, retirement of `AgentSupervisorConfig::project_dir`, retirement of the `--dir` CLI flag as a workspace hint (replaced by `--source-tree` for tugtool's own dev-mode needs).
- **Out of scope, deferred:** making `BuildStatusCollector` per-workspace (it can stay tugtool-source-tree-scoped via `--source-tree`); retiring `--source-tree` in favor of compile-time defaults; any tugdeck UI for picking a project path at card-open time (the plumbing is ready in W2; the UI affordance lives in T3.4.c).

---

##### T3.0.W1 — WorkspaceRegistry, one-shot construction {#t3-workspace-registry-w1}

**Goal:** Introduce `WorkspaceRegistry` as the owner of per-project feed bundles. Route `FileWatcher` / `FilesystemFeed` / `FileTreeFeed` / `GitFeed` construction through it. At startup, the registry pre-creates exactly one workspace from the existing `--dir` arg so behavior is bit-identical with today. No new wire frames, no per-session binding yet.

**Why this shape:** W1 is a pure refactor — everything the registry builds at startup is what `main.rs` already builds eagerly today. What changes is *where* the construction lives and *how* frames identify themselves. Isolating the refactor from the per-session binding (W2) keeps the diff reviewable and lets the test suite run against a known-good post-refactor shape before new CONTROL payload fields are introduced.

**Work:**

File: `tugrust/crates/tugcast/src/feeds/workspace_registry.rs` (new).

- New struct `WorkspaceRegistry` holding an internal `Mutex<HashMap<WorkspaceKey, Arc<WorkspaceEntry>>>`. `WorkspaceKey` is a newtype over `String` carrying a canonicalized absolute path.
- `WorkspaceEntry` holds `{key, project_dir, ref_count: AtomicUsize, file_watcher: Arc<FileWatcher>, fs_broadcast_tx, filetree_task, filesystem_task, git_task, cancel: CancellationToken}`. Construction of an entry spawns the three feed tasks and installs the `notify` watcher via `FileWatcher`.
- `get_or_create(&self, project_dir: &Path) -> Result<Arc<WorkspaceEntry>, WorkspaceError>` canonicalizes the path, looks up the existing entry, bumps the refcount, or creates a fresh entry if none exists.
- `release(&self, key: &WorkspaceKey)` decrements the refcount. **In W1 only, the refcount floor is 1** — the initial bootstrap entry is never released, so W1 doesn't need to exercise the teardown path. Teardown ships in W2.
- **Feed frame tagging.** The three workspace-scoped feeds splice a `workspace_key` field as the first JSON field in every frame they publish, mirroring the existing `splice_tug_session_id` pattern used for `CODE_OUTPUT` per [§P2 integration reference](#p2-integration-reference).
- **`main.rs` change.** Replace the block at `main.rs:200-250` (`FileWatcher::new(watch_dir.clone())`, `FilesystemFeed::new`, `FileTreeFeed::new`, `GitFeed::new`) with `WorkspaceRegistry::new()` followed by `registry.get_or_create(&watch_dir)?` to produce the bootstrap workspace. The existing router wiring remains, now fed by the bootstrap `WorkspaceEntry`.
- **Tugdeck-side filter.** Update the stores that subscribe to `FILETREE` / `FILESYSTEM` / `GIT` to filter on `decoded.workspace_key`. In W1, since there's only one workspace, the filter matches the bootstrap key and is effectively a no-op — but the code path is live.

**Exit criteria:**
- `cd tugrust && cargo nextest run` green.
- Existing `tugcast --dir <path>` behavior is bit-identical pre/post W1: file tree queries return the same results, filesystem events flow, git status reports the same state.
- `test_workspace_registry_bootstrap_construction` asserts `get_or_create` on a fresh path creates an entry with all three feed tasks running and refcount 1.
- `test_workspace_registry_deduplicates_canonical_paths` asserts two `get_or_create` calls with paths that canonicalize to the same directory return the same `Arc<WorkspaceEntry>` and produce refcount 2.
- All `FILETREE` / `FILESYSTEM` / `GIT` payloads observed on a running `tugcast` are JSON objects whose first field is `workspace_key` matching the bootstrap workspace.

**Scope:** ~300-400 lines of Rust (new `workspace_registry.rs`, `workspace_key` splicing in the three feed modules, `main.rs` edits). No tugdeck business-logic changes beyond adding one-line filter closures to the three existing feed subscriptions.

**Schedule:** Lands before W2. No wire-protocol CONTROL change (payload additions only).

---

##### T3.0.W2 — Per-session workspace binding on spawn_session {#t3-workspace-registry-w2}

**Goal:** Workspaces become per-session. Client picks a `project_dir` at card mount and ships it alongside `card_id` / `tug_session_id` on the `spawn_session` CONTROL frame. The supervisor canonicalizes the path, drives `WorkspaceRegistry::get_or_create(project_dir)`, stores the resulting `workspace_key` on the `LedgerEntry`, and hands the canonical `project_dir` to `TugcodeSpawner::spawn_child` so Claude's cwd matches the workspace root. `close_session` releases the workspace refcount; when the last session for a given path closes, the workspace tears down.

**Why this shape:** Once sessions carry their own project path on the wire, Job A (workspace feeds) and Job B (Claude cwd) coordinate at the CONTROL layer instead of the supervisor-config layer. A card pointed at `/frontend` and a card pointed at `/backend` get distinct `FileWatcher`s, distinct `GitFeed`s, distinct tugcode subprocesses, distinct Claude cwds — all derived from the one `project_dir` field the client sent. The `system_metadata.cwd` echoed back in the stream matches by construction.

**Work:**

Wire protocol:
- `encodeSpawnSession(cardId, tugSessionId, projectDir): Frame` gains a third parameter. Corresponding update to the CONTROL wire payload table at [§P2 integration reference](#p2-integration-reference): `{action: "spawn_session", card_id, tug_session_id, project_dir}`.
- `AgentSupervisor::handle_control`'s `spawn_session` branch reads `project_dir`, canonicalizes and validates it (exists, is a directory). New `ControlError::InvalidProjectDir { reason: &'static str }` variant maps to a CONTROL error frame on failure.
- `LedgerEntry` gains `workspace_key: WorkspaceKey` and `project_dir: PathBuf` fields, populated in `handle_control` before `spawn_session_worker` is scheduled.

Spawner plumbing:
- `ChildSpawner::spawn_child` trait method changes to `spawn_child(&self, project_dir: &Path) -> SpawnFuture`. Test doubles (`StallSpawner`, `CrashingSpawner`, `ScriptedSpawner`) accept and ignore the argument.
- `TugcodeSpawner` drops its `project_dir` field — it becomes a stateless wrapper around `tugcode_path`. `spawn_child` builds the `Command` with `.arg("--dir").arg(project_dir)` at call time.
- `SpawnerFactory` stops closing over `project_dir`. `default_spawner_factory` returns a single cheap spawner cloned across sessions.
- `spawn_session_worker` reads `ledger_entry.project_dir` and passes it through to `spawner.spawn_child(&project_dir)`.

Workspace lifecycle tied to session lifecycle:
- On `spawn_session`, after validation, the supervisor calls `registry.get_or_create(&project_dir)` and stores `workspace_key` on the ledger entry. Bumps refcount.
- On `close_session`, the supervisor calls `registry.release(&workspace_key)`. If refcount hits zero, the entry's `CancellationToken` fires, the three feed tasks exit cleanly, and the entry is removed from the registry map.
- On `reset_session`, the workspace binding is preserved — reset kills the tugcode subprocess and respawns, but does not cycle the workspace feeds.

Persistence:
- `SessionKeysStore` blob shape gains `project_dir: String` alongside `tug_session_id` / `claude_session_id`. Coordinate with [P14](#p14-claude-code-resume-for-persistent-session-history-high) so both field additions land as one coherent schema bump if they're concurrent; otherwise W2 adds its field and P14 extends.
- `rebind_from_tugbank` reads the new field. On rehydrate, the supervisor re-populates workspace entries for each persisted session via `registry.get_or_create(project_dir)`. Intent records with invalid/missing `project_dir` are logged and dropped — a fresh `spawn_session` is needed to re-establish.

Tugdeck side:
- `tugdeck/src/protocol.ts` — `encodeSpawnSession` signature update.
- T3.4.c (Tide card registration, downstream) is where the UI gains a project-path affordance; until then, an integration-test-only constant path drives `spawn_session` for W2's own tests.

**Exit criteria:**
- `AgentSupervisorConfig::project_dir` is **removed** from the struct. `default_spawner_factory` no longer references any supervisor-wide project path.
- `cargo nextest run` green. New integration tests:
  - `test_two_sessions_two_workspaces` — spawn two sessions with distinct `project_dir`s, assert two workspace entries exist, assert each session's Claude subprocess reports its own `project_dir` as `system_metadata.cwd`, assert `FILETREE` / `GIT` frames from each session carry distinct `workspace_key` values.
  - `test_two_sessions_same_project_share_workspace` — spawn two sessions with the same canonical `project_dir`, assert refcount 2, assert both receive `FILETREE` frames from the same workspace, assert closing one keeps the workspace alive.
  - `test_workspace_teardown_on_last_session_close` — spawn one session, close it, assert the workspace is removed from the registry and the feed tasks have exited.
  - `test_spawn_session_rejects_invalid_project_dir` — spawn with a nonexistent path, assert CONTROL error frame with detail `"invalid_project_dir"`.
- `encodeSpawnSession` callsites in tests and integration code compile against the new signature.

**Scope:** ~400-500 lines of Rust (CONTROL payload parsing, `LedgerEntry` fields, `ChildSpawner` trait change, workspace lifecycle hooks, new integration tests) + `protocol.ts` signature update + tugbank blob shape change.

**Schedule:** Lands after W1, before W3. Leaves `--dir` as a bootstrap path temporarily — W3 removes that last thread.

---

##### T3.0.W3 — Retire tugcast's workspace-dir CLI flag entirely {#t3-workspace-registry-w3}

**Goal:** Remove the "tugcast has a workspace" concept from the codebase entirely, and — separately — remove the CLI's ability to point tugcast at its own source tree, because that path has no honest user-facing meaning. Tugcast ultimately launches with an empty `WorkspaceRegistry` and acquires workspaces only via client `spawn_session{project_dir}`. Tugcast's own internal resources (the `tugdeck/dist/` frontend bundle, the dev-mode `tugcode/src/main.ts` fallback, the dev-mode cargo `target/` for `BuildStatusCollector`) are discovered via build-mode dispatch with zero CLI surface.

**Why this shape:** After W2, `--dir` is doing two unrelated things that share a variable: (a) workspace bootstrap — a relic of W1's need to preserve bit-identical behavior, now structurally unnecessary because workspaces are client-driven; and (b) **tugtool source-tree locator** — finding tugcast's own internal assets, the `tugdeck` frontend bundle, the dev-mode tugcode fallback, the cargo `target/` dir. Job (b) is **not user-configurable in any honest sense**. In dev, a binary built from checkout A cannot serve resources from checkout B — the build baked the path in at compile time. In production, resources live at a fixed bundle-relative location next to the binary (`Tug.app/Contents/Resources/`). Neither case benefits from a CLI override. Exposing one is an invitation for misconfiguration and pretends a knob exists that doesn't. So W3 ultimately removes the CLI flag outright — there is no `--source-tree` as a long-term flag — and replaces Job (b) with a small private helper that dispatches on build mode.

**Split into W3.a + W3.b:** W3 is sequenced into two sub-steps so every intermediate commit keeps Tug.app's daily development workflow in a fully-working state. [W3.a](#t3-workspace-registry-w3a) lands the source-tree helper and all the dev-only `#[cfg]` gating while **keeping the bootstrap workspace alive** (renaming `--dir` to `--source-tree` as a transitional measure). [W3.b](#t3-workspace-registry-w3b) rides with [T3.4.c](#t3-4-c-tide-card) and deletes the bootstrap workspace + the `--source-tree` flag in one coherent commit, at the exact point where the Tide card's UI picker makes a launch-time workspace unnecessary. See [Execution Order](#execution-order-w2-to-tide) for the full sequence.

---

###### T3.0.W3.a — CLI rename + source-tree helper + dev-only gating (bootstrap kept) {#t3-workspace-registry-w3a}

**Goal:** Introduce the `resources::source_tree()` helper, route all internal resource lookups through it, gate dev-only code paths behind `#[cfg(debug_assertions)]`, and rename the `--dir` CLI flag to `--source-tree` as a transitional measure. **Keep the W1 bootstrap workspace alive** so the running Tug.app still shows git/filetree card content during T3.4.a → T3.4.b development.

**Why keep the bootstrap for now:** Removing the bootstrap workspace before the Tide card's UI picker exists ([T3.4.c](#t3-4-c-tide-card)) creates a regression window where the existing git/filetree cards register on mount, subscribe to `FILETREE` / `FILESYSTEM` / `GIT`, and never receive a frame — because nothing is publishing one. Developers doing T3.4.a and T3.4.b work would stare at empty `Loading...` placeholders in the app. The W3.a/W3.b split closes that window: the destructive bootstrap-removal work rides with T3.4.c in [W3.b](#t3-workspace-registry-w3b), where the UI picker is landing in the same commit and the first real `spawn_session` flow replaces the bootstrap as the source of workspace frames.

**Work:**

New module — `tugrust/crates/tugcast/src/resources.rs` (new):
- `pub(crate) fn source_tree() -> PathBuf`. In `#[cfg(debug_assertions)]` (dev/cargo) builds, returns the tugtool workspace root derived at compile time from `env!("CARGO_MANIFEST_DIR")` by walking three parents up (`tugcast` crate → `crates` → `tugrust` → workspace root). In `#[cfg(not(debug_assertions))]` (release/bundled) builds, returns the bundle-relative `Resources` directory derived at runtime from `std::env::current_exe()` by walking to the `.app/Contents/` ancestor and joining `Resources`. The exact bundle walk is pinned to whatever layout Tug.app decides; if that layout changes, this is the one place to update.

CLI flag rename (NOT deletion — W3.b deletes it):
- Rename `cli.dir` → `cli.source_tree` in `main.rs`'s clap definition; the flag becomes `--source-tree`. Short-form `-d` (if any) either goes away or is kept as a transitional alias with a deprecation warning. The variable the flag populates continues to feed the bootstrap `registry.get_or_create(&watch_dir, cancel.clone())` call exactly as W1 wired it.
- The bootstrap workspace stays alive. `WorkspaceRegistry::new()` is still called, and the first `get_or_create` call still runs with the CLI-provided path.

Job (b) callsite updates (all can happen without removing the bootstrap):
- **`resolve_tugcode_path`** at `agent_bridge.rs:88` stops taking a parameter for the source tree and reads from `resources::source_tree()` internally. Its `.ts` fallback path becomes `resources::source_tree().join("tugcode/src/main.ts")` and the whole fallback branch is wrapped in `#[cfg(debug_assertions)]` — in release builds, tugcode is only ever resolved as a compiled binary on `PATH` or in the bundle, and the `.ts` fallback does not exist in the compiled output at all.
- **`BuildStatusCollector`** — dev-only. The entire `BuildStatusCollector::new(...)` construction in `main.rs:257-259` and the feed registration that follows are wrapped in `#[cfg(debug_assertions)]`. `STATS_BUILD_STATUS` simply does not publish in a production Tug.app. Tugdeck's chrome treats an absent/empty `STATS_BUILD_STATUS` feed as "widget not available" and hides the display. The `target/` path is `resources::source_tree().join("target")` inside the dev-only block. **Followup (not in W3 scope):** per-workspace `BuildStatusCollector` that detects `Cargo.toml` / `package.json` / `go.mod` in each workspace and publishes a per-workspace build status. Would replace the dev-only chrome widget with a workspace-scoped feature. Tracked separately.
- **`server.rs`'s `source_tree: Option<PathBuf>` parameter** is deleted. `build_app` and `run_server` no longer take it. The `dist_path` computation becomes `resources::source_tree().join("tugdeck").join("dist")` — same path expression, now sourced from the helper rather than threaded through function parameters. Static serving works in both dev (Vite prebuild or `bun run build` output) and prod (bundled `dist/`) without any caller-side knowledge.
- **`migrate_settings_to_tugbank(&watch_dir, client)`** — wrap the callsite in `#[cfg(debug_assertions)]`. The legacy flat-file settings only ever existed on developer machines during the pre-tugbank transition; production Tug.app has no legacy state to migrate. Inside the dev-only block, the path becomes `resources::source_tree()`. Long-term the function itself is a deletion candidate (tracked separately).

Documentation updates (partial — final pass in W3.b):
- README, `tugtool worktree setup` scaffolding, and any developer setup notes that mention `tugcast --dir` are updated to say `--source-tree`. Note in the same pass that the flag is transitional and will be removed in T3.4.c. Full deletion of these references happens in W3.b.

`AgentSupervisorConfig::project_dir` confirmation:
- This field **was already deleted** in [T3.0.W2 Step 6](#t3-workspace-registry-w2). W3.a should `rg AgentSupervisorConfig::project_dir tugrust/crates/tugcast/src` and confirm zero matches — if any residual references slipped through Step 6's grep audit, delete them now.

**Exit criteria:**
- `tugcast` launches with `--source-tree` (not `--dir`); `--dir` is gone or deprecated.
- `resources::source_tree()` exists and is used by `resolve_tugcode_path`, `server.rs`, `BuildStatusCollector` (dev-only), and `migrate_settings_to_tugbank` (dev-only).
- A release build (`cargo build --release`) compiles with `BuildStatusCollector`, the `.ts` tugcode fallback, and the legacy settings migration all `#[cfg]`-gated out — confirmed by reading the expanded module tree or by a `cargo expand --release` spot check. Production tugcast binary contains no references to `env!("CARGO_MANIFEST_DIR")` through `resources::source_tree()` — the release path walks `current_exe()` only.
- `rg AgentSupervisorConfig::project_dir tugrust/crates/tugcast/src` returns zero matches.
- The W1 bootstrap workspace **still exists** — daily development against Tug.app continues to show git/filetree card content from whatever directory `--source-tree` points at.
- Dev-mode tugdeck is still served correctly: `resources::source_tree().join("tugdeck/dist")` resolves to `<repo>/tugdeck/dist/` and static serving works.
- `cargo nextest run` green; `cargo build -p tugcast` clean under `-D warnings`.

**Scope:** ~150-200 lines of Rust touching `main.rs` (CLI rename + `#[cfg]` gating of `BuildStatusCollector` and legacy migration), new `resources.rs` module (~40 lines including both cfg branches), `agent_bridge.rs` (`.ts` fallback gating + path update), `server.rs` (parameter removal), plus developer-facing docs.

**Schedule:** Lands after [W2 closeout](#t3-workspace-registry-w2), before [T3.4.a](#t3-4-a-code-session-store). See [Execution Order](#execution-order-w2-to-tide) for the full sequence.

---

###### T3.0.W3.b — Retire bootstrap workspace + delete `--source-tree` (rides with T3.4.c) {#t3-workspace-registry-w3b}

**Goal:** Delete the W1 bootstrap workspace and the `--source-tree` CLI flag entirely. Tugcast ends this step launching with an empty `WorkspaceRegistry` and acquiring workspaces only via client `spawn_session{project_dir}`.

**Why this rides with T3.4.c:** The bootstrap workspace's sole remaining purpose after [W3.a](#t3-workspace-registry-w3a) is to make the existing git/filetree cards show content in daily development. Once [T3.4.c](#t3-4-c-tide-card) lands with the Tide card's UI picker, cards mount with an explicit `project_dir` from the user's choice and send `spawn_session` themselves — there is nothing left for the bootstrap to do. Landing the removal in the same commit as T3.4.c keeps the transition atomic: no intermediate commit has both "bootstrap gone" and "no UI picker yet."

**Work:**

CLI flag removal:
- Delete `cli.source_tree` from `main.rs`'s clap definition. Tugcast takes no positional args and no `--source-tree` flag. Its remaining CLI surface is tugbank path, port, auth config.

Bootstrap removal:
- Delete the `registry.get_or_create(&watch_dir, cancel.clone())` bootstrap call. `WorkspaceRegistry::new()` is still called; no workspaces are pre-created; the map starts empty.
- Delete the `let bootstrap = ...` binding and all references to `bootstrap.fs_watch_rx` / `bootstrap.ft_watch_rx` / `bootstrap.git_watch_rx` / `bootstrap.ft_query_tx` in `main.rs`'s router wiring. The router's FILETREE_QUERY adapter and the watch-receiver registrations that assumed a single bootstrap workspace are either removed (if they were bootstrap-specific) or rewritten to work from the registry alone (if they need to fan out across multiple workspaces in future).
- Delete any `watch_dir` variable and `PathBuf` plumbing that was only kept alive to feed the bootstrap call.

Documentation updates (final pass):
- README, developer setup notes, `tugtool worktree setup` scaffolding: delete remaining references to `--source-tree` entirely. Instructions that used to say "run tugcast against the tugtool checkout" now say "run tugcast from a binary built in the tugtool checkout" — the same language W3's original writeup specified, now landing in this sub-step.

Test updates:
- New test `test_startup_has_no_bootstrap_workspace` in `feeds/workspace_registry.rs` or `tests/` — constructs a fresh `WorkspaceRegistry`, asserts `inner_for_test().len() == 0`, drops the registry cleanly.
- Any existing integration test that assumed the bootstrap workspace ([grep for `bootstrap.` and `watch_dir` in the test suite](../tugrust/crates/tugcast/tests/)) is either rewritten to call `spawn_session` explicitly or deleted if it's redundant with T3.4.c's card-mount tests.

**Exit criteria:**
- `tugcast` launches with no path argument. The entire `--dir` / `--source-tree` CLI surface is gone.
- `rg -- '--dir|--source-tree' tugrust/crates/tugcast/src` returns zero matches (no residual flag plumbing).
- A fresh `tugcast` launched with no connected clients has an empty `WorkspaceRegistry`. `test_startup_has_no_bootstrap_workspace` passes.
- A client that connects, sends `spawn_session{card_id, tug_session_id, project_dir}` with a valid path, and then sends a `CODE_INPUT` turn, receives feed frames for `FILETREE` / `FILESYSTEM` / `GIT` whose `workspace_key` matches their chosen `project_dir`, and a `system_metadata.cwd` from Claude that also matches. **This is the manual A/B smoke deferred from [W2 Step 8](#t3-workspace-registry-w2).**
- `cargo nextest run` green; `cargo build -p tugcast` clean under `-D warnings`.

**Scope:** ~50-100 lines of Rust touching `main.rs` (CLI deletion, bootstrap deletion, router wiring cleanup), new test, docs cleanup.

**Schedule:** Lands alongside [T3.4.c](#t3-4-c-tide-card) in the same commit, or as its immediate follow-on. See [Execution Order](#execution-order-w2-to-tide) for the full sequence. T3.4.a then inherits a world where tugcast has no launch-time project configuration at all — the workspace comes from CONTROL frames, the source tree is discovered from the build — and `sessionKey` is honestly a display label with every other field having a single, unambiguous role.

---

#### T3.4: Tide Card — prompt-entry + turn state + live surface {#t3-prompt-entry}

**Goal:** Deliver the complete **TIDE: INPUT** experience as a working, registered Tide card. This phase supplies the three missing pieces — the turn-state store, the composition component, and the card registration — and closes out T3 by driving a real `user_message` round-trip through `CODE_INPUT` / `CODE_OUTPUT`.

**Prerequisites:** T3.2 (tug-prompt-input), T3.3 (stores), [T3.0.W](#t3-workspace-registry) (W1/W2/W3 — per-session `project_dir` on the wire, workspace registry, retirement of `--dir`), `tug-split-pane` (archived plan, shipped), `tug-markdown-view` streaming API, [session-metadata-feed.md](session-metadata-feed.md) (SESSION_METADATA feed wired to tugcast).

**Governing documents:**
- [Component Authoring Guide](../tuglaws/component-authoring.md) — compound composition pattern, token sovereignty [L20], `@tug-pairings`, checklist
- [Token Naming](../tuglaws/token-naming.md) — seven-slot `--tug7-` convention for prompt-entry theme tokens
- [transport-exploration.md](transport-exploration.md) — authoritative catalog of outbound `CODE_OUTPUT` events and inbound `CODE_INPUT` messages; Test 1, 2, 6, 8, 11 are directly load-bearing for the state machine
- [ws-verification.md](ws-verification.md) — end-to-end WebSocket contract; `session_init` now on watch channel, safe to rely on during card mount
- [session-metadata-feed.md](session-metadata-feed.md) — `SessionMetadataStore` reads from `SESSION_METADATA` (0x51) snapshot feed, not `CODE_OUTPUT`
- [tug-feed.md](tug-feed.md) — reserved feed slot / future tug-feed integration; the Tide card should not couple to tug-feed yet, but CodeSessionStore's `phase` taxonomy should remain compatible with the event types listed there
- Laws: [L02] external state via `useSyncExternalStore`, [L06] appearance via CSS/DOM, [L11] controls emit actions, [L15] token-driven states, [L16] pairings declared, [L19] component authoring guide, [L20] token sovereignty, [L22] direct DOM updates, [L23] persistence
- **Covers:** U4 (interrupt), U5 (streaming indicator), U12 (slash commands), U13 (`@` file completion), U19 (message queueing)

---

##### T3.4.a — CodeSessionStore (turn state machine) ✓ LANDED {#t3-4-a-code-session-store}

> **Status:** ✓ LANDED. Implemented per [`tugplan-code-session-store.md`](tugplan-code-session-store.md) (Steps 1–10). `tugdeck/src/lib/code-session-store.ts` exports `CodeSessionStore`, `CodeSessionSnapshot`, `TurnEntry`, `ToolCallState`, `ControlRequestForward`, `CostSnapshot`, and `CodeSessionPhase`. 91 store tests green (2039 full-suite).
>
> **Companion store: TideSessionLedgerStore.** The CodeSessionStore is per-card and owns one in-flight session's turn state. The cross-card metadata that used to live in the tugbank `sessions` map and `live-sessions` set — timestamps, turn count, first-user-prompt snippets, lifecycle state, current card binding — moved into a tugcast-side sqlite ledger and a tugdeck client store at `tugdeck/src/lib/tide-session-ledger-store.ts`. The picker reads that store via `useSessionLedger(projectDir)` instead of `useTugbankValue("dev.tugtool.tide", "sessions", …)`. See [`tugplan-tide-session-ledger.md`](tugplan-tide-session-ledger.md) for the full design (schema, CONTROL ops, eviction, trash mechanics).

**Goal:** A new L02 store that owns everything the Tide card needs to know about a Claude Code session in flight. Nothing about turn state lives in React components, in `tug-prompt-input`, or in `tug-prompt-entry`. One instance per Tide card, one backing Claude session per instance, no shared state between cards.

**Prerequisite reading.** Four documents form the complete context for this work. Read them in this order before writing any code:

1. **[§P2 integration reference](#p2-integration-reference)** (above) — the **stabilized wire contract** this store is built against. Covers CODE_OUTPUT / CODE_INPUT / SESSION_STATE / SESSION_METADATA / CONTROL payload shapes, the lifecycle order for a typical card, the tugdeck client-side builders (`encodeSpawnSession` / `encodeCloseSession` / `encodeResetSession` / `encodeCodeInput`), the `FeedStore` per-card filter API, and the server-side entry-point table. The plan that produced this surface is [`dash/tugplan-multi-session-router.md`](tugplan-multi-session-router.md) if you need the full rationale.

2. **[T3.0.W1](tugplan-workspace-registry-w1.md) / [W2](tugplan-workspace-registry-w2.md) / [W3.a](tugplan-workspace-registry-w3a.md)** — the **per-session workspace binding** this store assumes is in place. After W2, `spawn_session` carries `project_dir` as a required field, `WorkspaceRegistry` reference-counts feed bundles per canonical project path, `LedgerEntry.workspace_key` binds each session to its workspace, `SessionKeyRecord { tug_session_id, project_dir, claude_session_id }` is the persisted shape, and tugdeck's `CardSessionBindingStore` + `useCardWorkspaceKey` hook provide the card-level identity-resolution layer. T3.4.a builds on top of that layer; it does not re-invent it.

3. **[`dash/transport-exploration.md`](transport-exploration.md)** — the **empirical catalog of Claude Code stream-json semantics**. 35 probes against a real tugcode/claude backend covering every event shape, delta rule, ordering guarantee, interrupt pattern, slash-command quirk, session-command behavior, and attachment path.

   **Ground truth is the golden fixture directory**, not the prose catalog. As of [§P2 follow-up](#p2-followup-golden-catalog), the authoritative machine-readable reference is `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v<version>/` — one JSONL file per probe, recorded against a specific `claude` version. Start there for exact shapes; use the prose for rationale and ordering narrative. When the two disagree, the fixtures win.

   The current baseline is `v2.1.105/` and its manifest-pinned probe list is the minimum set of stream-json behaviors CodeSessionStore must handle. The [drift test](#p2-followup-golden-catalog) (`stream_json_catalog_drift.rs`) guards against silent regressions; [P15](#p15-stream-json-version-gate) adds the runtime version-gate and divergence telemetry that land *after* T3.4.a so this store's reducer can inform what fields are version-sensitive.

   Essential probes for T3.4.a, by **fixture filename** (all under `v2.1.105/`):

   - **`test-01-round-trip.jsonl`, `test-02-streaming-deltas.jsonl`, `test-10-pacing.jsonl`** — basic round-trip, streaming-delta accumulation rule (partials are deltas, `complete` is full), pacing, `thinking_text` ordering before `assistant_text`.
   - **`test-05-tool-use.jsonl`, `test-07-tool-interleave.jsonl`, `test-09-tool-structured.jsonl`, `test-21-concurrent-tools.jsonl`, `test-22-subagent.jsonl`** — tool-call lifecycle, concurrent-call interleaving (events correlated by `tool_use_id`), `tool_use_structured` shapes for Read/Bash/Edit, subagent tool calls bracketed by the parent Agent `tool_use_id`.
   - **`test-06-interrupt.jsonl`, `test-14-mid-turn-send.jsonl`** — interrupt semantics. `interrupt` surfaces as `turn_complete(result: "error")`, **not** a dedicated `turn_cancelled`. Mid-turn `user_message` sends do NOT interrupt — they queue.
   - **`test-08-permission.jsonl`, `test-11-tool-deny.jsonl`, `test-35-ask-user-question.jsonl`** — `control_request_forward` is the **unified gate event** for permissions and `AskUserQuestion`, differentiated by `is_question`. Permission responses use `tool_approval`; questions use `question_answer`. Both carry `request_id` for correlation.
   - **`test-13-session-new.jsonl`, `test-17-session-continue.jsonl`, `test-20-session-fork.jsonl`** — *currently skipped* in the `v2.1.105/` manifest pending [P16](#p16-session-command-continue). T3.4.a is single-session-per-store; `session_command` routing is outside the first landing. Included here only so the implementer knows they are deliberately out of scope and will be re-enabled when P16 closes.
   - **`test-03-*.jsonl`, `test-04-*.jsonl`, `test-12-*.jsonl`, `test-15-*.jsonl`, `test-19-*.jsonl`, `test-26-*.jsonl`, `test-30-*.jsonl`** — slash-command landscape in three categories: (a) skill-based with text output via replay; (b) skill-based with no text (only structured events like `cost_update`); (c) terminal-only commands the Tide card must reimplement from cached `system_metadata` (Phase T10). For T3.4.a the store treats (a) and (b) identically — a turn is a turn regardless of whether it produced `assistant_text` — and is oblivious to (c).
   - **`test-23-attachment.jsonl`, `test-24-at-file.jsonl`** — base64 image attachments and file references on `user_message.attachments[]`.
   - **`test-16-model-change.jsonl`** — `model_change` produces a synthetic `assistant_text` confirmation and updates the next `system_metadata`; treat it as a normal turn.

4. **[`dash/ws-verification.md`](ws-verification.md)** — brief. The WebSocket transport is verified green; T8/T9/T10/T11 fixes are landed. Context for "don't re-verify the transport; trust it."

**Optional:** [`dash/tide-conversation-log.md`](tide-conversation-log.md) — strategic context for why Tide cards are long-lived chat threads rather than ephemeral panes. Not required for implementation.

**Essential wire-level invariants** (violate these and CodeSessionStore silently corrupts its own state):

- **Text accumulation is the store's job.** `assistant_text` partials carry *deltas*, not accumulated text. The `complete` event has the full text. Accumulate deltas during `is_partial: true`; on `complete`, replace the accumulator with the authoritative full text. Same rule for `thinking_text`.
- **Tool events interleave across concurrent calls.** Don't assume `tool_use → tool_result → tool_use_structured` ordering when multiple tool calls are in flight. Each group is correlated by `tool_use_id`; track them independently in a `Map<tool_use_id, ToolCallState>`.
- **Interrupt surfaces as `turn_complete(result: "error")`.** There is NO `turn_cancelled` event. The `interrupted` phase triggers on `turn_complete` with `result === "error"`, not on a cancellation event that never fires.
- **`control_request_forward` is one event type for two UI flows.** Dispatch on `is_question`: `false` → permission (respond with `tool_approval`); `true` → question (respond with `question_answer`). Both carry `request_id` for response correlation.
- **`system_metadata` is chrome source of truth** — but it's consumed by `SessionMetadataStore`, **not** `CodeSessionStore`. The two stores are independent; the Tide card holds references to both. CodeSessionStore does not read `system_metadata` directly.
- **Slash commands with terminal-only behavior produce NO text.** A short turn that emits only `cost_update` + `turn_complete` is a legitimate completion. Don't block idle-transition waiting for `assistant_text`.

---

**Identity model.** After W2, a Tide card carries three distinct identifiers, each with a single purpose:

| Identifier | Purpose | Lifetime | Who mints |
|------------|---------|----------|-----------|
| `tug_session_id` | Wire-level routing key. Every CODE_OUTPUT / CODE_INPUT / SESSION_STATE / SESSION_METADATA frame carries this as its first field. Store subscribes to feeds with a filter keyed on this value. | Per card, persisted via `CardSessionBindingStore`; survives reload. | Client-side on first mount: `crypto.randomUUID()`. |
| `claude_session_id` | Claude Code's own session id, appears in `session_init.session_id`. Drives `--resume` in [P14](#p14-claude-resume). | Per Claude subprocess lifetime. | Claude, captured in `relay_session_io`'s atomic-promote block. |
| `project_dir` | Canonical project path; becomes Claude's cwd AND the workspace key for FILETREE / FILESYSTEM / GIT feeds. | Per card, persisted via `CardSessionBindingStore`. | User, selected via the Tide card's picker (T3.4.c); validated server-side by `spawn_session`. |

The store operates entirely on `tug_session_id`. It observes `claude_session_id` through `session_init` only to expose it on the snapshot for downstream display. It never sees `project_dir` directly — that's the card's responsibility at spawn time.

A fourth value — **`displayLabel`** — is an optional human-readable string ("my scratch thread") that the card passes in for UI chrome. It has **zero wire footprint**. It is not used for filtering, routing, correlation, or persistence-as-identity. It's the name that appears in a tab and nowhere else.

---

**Lifecycle ownership.** The Tide card (T3.4.c) owns the `spawn_session` / `close_session` CONTROL frames. The CodeSessionStore owns turn state and message I/O on an already-claimed session. The card constructs the store *after* it has called `encodeSpawnSession(cardId, tugSessionId, projectDir)` and persisted the binding via `CardSessionBindingStore.setBinding`. This keeps the store's responsibilities tight: it handles what happens on a live session, not how the session is brought up.

Concretely: the store can be constructed while `SESSION_STATE` is still `pending` (lazy spawn — the first `send()` is what actually flips the ledger `Idle → Spawning`). The store tracks `SESSION_STATE` transitions internally and exposes readiness via the snapshot.

---

**Work:**

File: `tugdeck/src/lib/code-session-store.ts` (new).

**Constructor:**

```ts
interface CodeSessionStoreOptions {
  conn: TugConnection;        // from getConnection()
  tugSessionId: string;       // already persisted via CardSessionBindingStore
  displayLabel?: string;      // UI-only; defaults to tugSessionId.slice(0, 8)
}

class CodeSessionStore {
  constructor(options: CodeSessionStoreOptions);
}
```

**Internal wiring:**

- On construction, the store builds its own filtered `FeedStore`:

  ```ts
  const filter = (_feedId, decoded) =>
    (decoded as { tug_session_id?: string }).tug_session_id === this.tugSessionId;
  this.feedStore = new FeedStore(
    conn,
    [FeedId.CODE_OUTPUT, FeedId.SESSION_STATE],
    undefined,
    filter,
  );
  ```

  The filter encapsulation is intentional: the store owns the filter shape, so consumers never construct a mis-keyed `FeedStore` by accident. `SESSION_METADATA` is *not* subscribed here — `SessionMetadataStore` owns that feed independently.

- Outbound dispatch goes through `encodeCodeInput(msg, tugSessionId)` from `tugdeck/src/protocol.ts`. The store calls `conn.send(...)` directly; consumers never see raw frames. Outbound message types (`user_message`, `interrupt`, `tool_approval`, `question_answer`) are all exposed as named actions — not as a generic `dispatch(bytes)` hole.

- `dispose()` tears down the `FeedStore`, clears listeners, and clears the queued-sends buffer. It does **not** send `close_session` — that's the card's job via `CardSessionBindingStore` / T3.4.c.

---

**Transcript and streaming model.** Tide cards are long-lived chat threads, so the store maintains a growing transcript — not a single in-flight scratch buffer that gets replaced per turn.

The store owns two pieces of per-card content state:

1. **`transcript: ReadonlyArray<TurnEntry>`** — immutable, append-only. Each completed turn becomes one `TurnEntry` with `{ msgId, userMessage, thinking, assistant, toolCalls, result, endedAt }`. Exposed on the snapshot; drives long-form history rendering.

2. **`streamingDocument: PropertyStore`** — owned by the store, constructed internally. Holds the *in-flight* turn's content at stable, stringly-named paths:
   - `"inflight.assistant"` — accumulated `assistant_text` deltas for the current turn.
   - `"inflight.thinking"` — accumulated `thinking_text` deltas.
   - `"inflight.tools"` — serialized `ToolCallState[]` for the current turn.

   `TugMarkdownView` observes whichever path the card wires up (see T3.4.c). The PropertyStore instance is exposed as a public property on the store (`store.streamingDocument`), not via the React snapshot, because PropertyStores aren't plain data. The snapshot exposes **only the path strings** so consumers can thread them through props without coupling to the instance.

On `turn_complete(success)`:
- The in-flight `assistant_text` accumulator is replaced with the `complete` event's authoritative full text (verification per fixture `test-02-streaming-deltas.jsonl`).
- A new `TurnEntry` is built from the in-flight state and appended to `transcript`.
- The `inflight.*` paths are cleared (set to empty strings / empty arrays).

On `turn_complete(error)` (interrupt path):
- The accumulated in-flight text is **preserved** — copied into the `TurnEntry` with `result: "interrupted"` — then committed to `transcript` and cleared from `inflight.*`.
- Per fixture `test-06-interrupt.jsonl`, the final partial's text is the user-visible truth.

This collapses the former `streamingStore / streamingPath / streamRegionKey` triplet into a single instance-owned `streamingDocument` plus a small set of stable path strings. There is exactly one `PropertyStore` per card, owned by the store.

---

**Turn-state machine.** Phases:

```
idle → submitting → awaiting_first_token → streaming
     ↘                                   ↘ tool_work ↔ streaming
                                          ↘ awaiting_approval ↔ streaming
                                          ↘ complete → idle
                                          ↘ interrupted → idle
                                          ↘ errored → idle
```

Transition table:

| From | Event | To | Notes |
|------|-------|----|----|
| `idle` | `send()` action | `submitting` | Write `user_message` frame to `CODE_INPUT`. May span a subprocess spawn (lazy spawn per §P2 integration reference). |
| `submitting` | First `thinking_text` / `assistant_text` partial with a new `msg_id` | `awaiting_first_token` → `streaming` | Fast collapse; `awaiting_first_token` exists so the UI can show "connecting…" distinct from "streaming". **Text-first turns only** — see tool-first note below. |
| `submitting` | First `tool_use` (tool-first turn) | `tool_work` | Tool-first turns (e.g. `v2.1.105/test-05`, `test-07`) skip `awaiting_first_token` entirely — there is no text token to react to, and collapsing through `awaiting_first_token` would require a second synthetic dispatch the reducer has no reason to emit. The prompt-entry UI should treat `phase ∈ { submitting, awaiting_first_token }` as the "connecting…" window so tool-first and text-first flows render the same affordance. |
| `streaming` | `assistant_text` partial (delta) | `streaming` | Append delta to `streamingDocument` at `inflight.assistant`. |
| `streaming` | `thinking_text` partial (delta) | `streaming` | Append delta to `inflight.thinking`. |
| `streaming` | `tool_use` partial/complete | `tool_work` | Sub-state; `canInterrupt` remains true. Upsert a `ToolCallState` in the in-flight tool map keyed by `tool_use_id`. |
| `tool_work` | `tool_use_structured` / `tool_result` (matching `tool_use_id`) | `streaming` | Back to streaming. Concurrent tool calls may keep the machine in `tool_work` until all ids resolve. |
| `streaming` / `tool_work` | `control_request_forward` (permission or question) | `awaiting_approval` | Dispatch on `is_question` to select `pendingApproval` vs `pendingQuestion`. Sub-state of the running turn; `canInterrupt` remains true. |
| `awaiting_approval` | `respondApproval()` / `respondQuestion()` | previous phase | Writes `tool_approval` / `question_answer` to `CODE_INPUT`. |
| any non-idle | `turn_complete(result: "success")` | `complete` → `idle` | Commit in-flight to `transcript`; clear `inflight.*`; flush one queued `send()` if any. |
| any non-idle | `turn_complete(result: "error")` | `interrupted` → `idle` | Per fixture `test-06-interrupt.jsonl`: interrupt surfaces here; preserve accumulated text into the transcript as `result: "interrupted"`. **Queue is cleared, not flushed** (see Actions). |
| any non-idle | `SESSION_STATE = errored` / connection close / `session_unknown` / `session_not_owned` | `errored` → `idle` | `lastError` set with a cause tag (see below); transcript preserved as-is. |
| `errored` | next `send()` | `submitting` | `send()` from `errored` is a manual recovery hook (user chooses to retry). The card UI may render a dedicated "try again" affordance. |

---

**Snapshot shape:**

```ts
interface CodeSessionSnapshot {
  phase: "idle" | "submitting" | "awaiting_first_token" | "streaming"
       | "tool_work" | "awaiting_approval" | "complete" | "interrupted" | "errored";

  // Identity (observed, not owned).
  tugSessionId: string;                     // constant; echoed from constructor
  claudeSessionId: string | null;           // from session_init; null until first spawn
  displayLabel: string;                     // UI chrome only

  // Live turn state.
  activeMsgId: string | null;
  canSubmit: boolean;                       // phase === "idle" (composition-emptiness is the component's concern)
  canInterrupt: boolean;                    // phase ∈ { submitting, awaiting_first_token, streaming, tool_work, awaiting_approval }
  pendingApproval: ControlRequestForward | null;
  pendingQuestion: ControlRequestForward | null;
  queuedSends: number;                      // U19 depth

  // Transcript (append-only).
  transcript: ReadonlyArray<TurnEntry>;

  // In-flight user submission. Set the moment `send()` dispatches and
  // cleared exactly when the matching `TurnEntry` lands on `transcript`
  // (`turn_complete(success)`) or the turn is interrupted. Mirrors the
  // reducer's `pendingUserMessage`; identity is stable across snapshot
  // rebuilds while the same submission is in flight. Drives the in-flight
  // `user` row in the Tide card transcript via `TideTranscriptDataSource`
  // (Step 10 of `tugplan-tug-list-view.md`).
  inflightUserMessage: { text: string; atoms: ReadonlyArray<AtomSegment> } | null;

  // Streaming paths (the PropertyStore instance lives on the store, not the snapshot).
  streamingPaths: {
    assistant: "inflight.assistant";
    thinking: "inflight.thinking";
    tools: "inflight.tools";
  };

  // Telemetry.
  lastCostUsd: number | null;               // from cost_update
  lastError: {
    cause: "session_state_errored" | "transport_closed" | "session_not_owned" | "session_unknown";
    message: string;
    at: number;                             // Date.now()
  } | null;
}
```

---

**Actions:**

- **`send(text: string, atoms: AtomSegment[], route: Route): void`** — serializes `{ type: "user_message", text, attachments: atoms.map(...) }` and dispatches via `encodeCodeInput(msg, tugSessionId)`. If `phase !== "idle"`, enqueues locally (D-T3-07). From `errored`, `send()` is a manual retry.
- **`interrupt(): void`** — dispatches `{ type: "interrupt" }` via `encodeCodeInput`. **Clears the local queue** — queued sends are discarded, not flushed on the next idle. Rationale: the user pressed Stop; any queued messages were typed with an expectation the current turn would complete. If the user still wants them, they can resubmit. Relies on `turn_complete(error)` arriving to drive the `interrupted → idle` transition.
- **`respondApproval(requestId: string, payload: { decision: "allow" | "deny"; updatedInput?: unknown; message?: string }): void`** — dispatches `{ type: "tool_approval", request_id, ... }`. Kept separate from `respondQuestion` (not unified under a single `respond()`) because the wire shapes are distinct and the split produces clearer call sites in the component layer.
- **`respondQuestion(requestId: string, payload: { answers: Record<string, unknown> }): void`** — dispatches `{ type: "question_answer", request_id, answers }`.
- **`dispose(): void`** — tears down the owned `FeedStore`, clears listeners, clears the queue, and clears `inflight.*` paths. Does not send `close_session`.

---

**`errored` phase triggers (fully specified).** The store transitions to `errored` on any of:

| Trigger | Source | `lastError.cause` | Detection |
|---------|--------|-------------------|-----------|
| `SESSION_STATE = errored` frame observed | supervisor (e.g. crash budget exhausted, future `concurrent_session_cap_exceeded` from P13) | `"session_state_errored"` | Filter-matched SESSION_STATE frame with `state === "errored"`; `detail` copied into `message`. |
| WebSocket connection closed while a turn is in flight | transport layer | `"transport_closed"` | `conn.onClose` observer; store subscribes while `phase !== "idle"` and transitions on close. |
| CONTROL error `session_not_owned` | router's P5 authz check | `"session_not_owned"` | Frame on CONTROL feed matching this card's `tugSessionId`. |
| CONTROL error `session_unknown` | supervisor dispatcher (orphaned session) | `"session_unknown"` | Same. |

`lastError` is preserved until the next successful `send()` completes, at which point it clears. The UI affordance driven by `errored` is left to T3.4.c; T3.4.a only populates the snapshot field.

**Not in scope for `errored`:**
- `turn_complete(result: "error")` — this is the **interrupt** path, not `errored`. Distinct transition.
- Malformed stream-json events — these are a stream_json_divergence concern handled by [P15](#p15-stream-json-version-gate); T3.4.a logs a `console.warn` and drops the frame without transitioning phase.

---

**Streaming accumulator (specifics):**

On each `assistant_text` frame:
1. Parse `msg_id`, `seq`, `text`, `is_partial`.
2. If `is_partial === true`:
   - Append `text` to an in-memory scratch buffer keyed by `msg_id`.
   - `this.streamingDocument.set("inflight.assistant", scratchBuffer)`.
3. If `is_partial === false` (the `complete` event):
   - Replace the scratch buffer with the authoritative `text` field.
   - `this.streamingDocument.set("inflight.assistant", scratchBuffer)`.
   - Do **not** commit to transcript yet — that happens on `turn_complete`, which can arrive with additional events between `complete` and the end of the turn.

Same pattern for `thinking_text` on `inflight.thinking`.

For tool calls, maintain `Map<tool_use_id, ToolCallState>` keyed on `tool_use_id`. On each `tool_use` / `tool_result` / `tool_use_structured` frame, upsert the corresponding entry and write the serialized map to `inflight.tools`.

---

**Test fixtures in Vitest.** Ground truth for unit tests is the golden fixture directory at `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.105/`. Vitest reads the `.jsonl` files directly via a tugdeck-side helper at `tugdeck/src/lib/code-session-store/testing/golden-catalog.ts`:

```ts
export function loadGoldenProbe(
  version: string,
  probeName: string,
): GoldenProbe {
  const relativePath = `../../../tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/${version}/${probeName}.jsonl`;
  const jsonl = readFileSync(resolve(__dirname, relativePath), "utf8");
  return parseGoldenProbe(jsonl);   // substitutes placeholders, returns typed events
}
```

The helper substitutes golden placeholders (`{{uuid}}`, `{{iso}}`, `{{msg_id}}`, `{{tool_use_id}}`, `{{f64}}`, `{{i64}}`, `{{text:len=N}}`) with test-fixture values deterministic to the test (not randomized), so each test asserts reducer behavior against a stable, known input stream. A mock `FeedStore` wraps the parsed frames and replays them to the store's subscription handler, producing exactly the same byte sequence the real router would emit.

**Rationale:** reading the `.jsonl` files in-place avoids copy/export drift between a Rust-owned source of truth and a tugdeck-owned copy. The drift test ([§P2 follow-up](#p2-followup-golden-catalog)) already guards against divergence on the Rust side. The relative path is stable because both `tugdeck/` and `tugrust/` live in the same repo root.

**Not chosen:**
- **Symlinking into `tugdeck/tests/fixtures/`** — creates duplication hazard and breaks on Windows.
- **A Rust-side export step** emitting a tugdeck-consumable bundle — adds a build step and a new bidirectional coupling for zero benefit.

---

**Exit criteria:**

Each exit-criterion test loads the named fixture via `loadGoldenProbe("v2.1.105", "test-NN-…")`, replays it against the store, and asserts the snapshot transitions and side-effects.

- **Basic round-trip (`test-01-round-trip.jsonl`, `test-02-streaming-deltas.jsonl`):** `send("hello")` writes a `user_message` CODE_INPUT frame via `encodeCodeInput`; replaying the fixture drives `idle → submitting → awaiting_first_token → streaming → complete → idle`; the snapshot's `transcript` has exactly one `TurnEntry`; `streamingDocument.get("inflight.assistant") === ""` after commit.
- **Delta accumulation (`test-02-streaming-deltas.jsonl`):** while streaming, `inflight.assistant` contains each delta concatenated in arrival order. On `complete`, the buffer equals the event's `text` field byte-for-byte.
- **Interrupt with text preservation (`test-06-interrupt.jsonl`):** while `phase === "streaming"`, call `interrupt()`; a mock assertion verifies the `interrupt` frame was written to CODE_INPUT. Replaying the fixture's `turn_complete(error)` frame drives `streaming → interrupted → idle`; `transcript` gets one entry with `result: "interrupted"` and the accumulated text preserved.
- **Interrupt clears the queue (new test, synthetic):** three `send()` calls during `streaming` leave `queuedSends === 3`. Call `interrupt()`. Replay `turn_complete(error)`. Assert `queuedSends === 0` after the transition to `idle`, and assert no `user_message` CODE_INPUT frames were written for the queued sends (only the original submit and the `interrupt`).
- **Queue flush on success (`test-01-round-trip.jsonl`, chained):** three `send()` calls during `streaming` leave `queuedSends === 3`. Replay `turn_complete(success)`. Assert the store writes exactly one queued `user_message` to CODE_INPUT (not all three — only the next send is flushed on each idle tick) and transitions `complete → idle → submitting`.
- **Tool call lifecycle (`test-05-tool-use.jsonl`):** `phase` flips to `tool_work` on the first `tool_use` partial; returns to `streaming` after `tool_use_structured` or `tool_result` matching the same `tool_use_id`; `inflight.tools` contains a serialized entry with the fixture's tool name.
- **Concurrent tools (`test-21-concurrent-tools.jsonl`):** two overlapping `tool_use_id`s both appear in `inflight.tools` simultaneously; `phase` remains `tool_work` until both are resolved.
- **Permission approval (`test-08-permission.jsonl`):** replaying `control_request_forward(is_question: false)` drives `streaming → awaiting_approval`; `pendingApproval` is populated. Calling `respondApproval(requestId, { decision: "allow" })` writes a `tool_approval` frame to CODE_INPUT with the correct `request_id` and `decision`.
- **Permission deny (`test-11-tool-deny.jsonl`):** same flow with `{ decision: "deny" }`; assert the resulting `tool_approval` frame carries `decision: "deny"`.
- **AskUserQuestion (`test-35-ask-user-question.jsonl`):** replaying `control_request_forward(is_question: true)` populates `pendingQuestion`; `respondQuestion(requestId, { answers })` writes a `question_answer` frame with the correct shape.
- **`errored` on SESSION_STATE (synthetic):** inject a `SESSION_STATE { state: "errored", detail: "crash_budget_exhausted" }` frame during `streaming`. Assert `phase → errored`, `lastError.cause === "session_state_errored"`, `lastError.message` contains `"crash_budget_exhausted"`, transcript preserved as-is.
- **`errored` on transport close (synthetic):** simulate `conn.onClose` while `phase === "submitting"`. Assert `phase → errored`, `lastError.cause === "transport_closed"`.
- **`errored` on CONTROL `session_not_owned` (synthetic):** inject a CONTROL error frame with `detail: "session_not_owned"` for this `tugSessionId`. Assert `phase → errored`, `lastError.cause === "session_not_owned"`.
- **Recovery from `errored`:** from `phase === "errored"`, call `send("retry")`. Assert `phase → submitting`, `lastError` is cleared once a subsequent `turn_complete(success)` lands.
- **Filter correctness:** construct two `CodeSessionStore` instances with distinct `tugSessionId`s against a shared mock connection. Replay a fixture stream tagged with only the first store's id; assert the second store's snapshot is unchanged.
- **`dispose()` teardown:** after `dispose()`, new frames on the connection do not update the snapshot; `streamingDocument` is cleared; no `close_session` frame was written (that's the card's responsibility).
- **No React imports.** `rg "from \"react\"" tugdeck/src/lib/code-session-store.ts` returns zero matches.

All tests run under Vitest (`cd tugdeck && bun test`). The store is pure TypeScript + L02 — no React, no DOM, no connection construction beyond what the constructor accepts.

---

##### T3.4.b — tug-prompt-entry (composition component) {#t3-4-b-prompt-entry}

**Goal:** A compound React component that composes `tug-prompt-input` + route indicator + submit/stop into a single token-scoped surface. All turn behavior is read from a `CodeSessionStore` passed in as a prop.

**Work:**

Files: `tugdeck/src/components/tugways/tug-prompt-entry.tsx` + `.css` (new).

- Props:

  ```ts
  interface TugPromptEntryProps {
    codeSessionStore: CodeSessionStore;
    sessionMetadataStore: SessionMetadataStore;
    historyStore: PromptHistoryStore;
    fileCompletionProvider: CompletionProvider;
    dropHandler?: DropHandler;
    sessionId: string;           // from CodeSessionStore snapshot
    className?: string;
  }
  ```

- Layout: a single flex column — `tug-prompt-input` (maximized, fills) on top, a bottom toolbar row with the route indicator on the left and the submit/stop button on the right. Token scope `--tug7-*-prompt-entry-*`. `@tug-pairings (compact, expanded)`. No descendant restyling of composed children per [L20].
- Snapshot subscription: `const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)` — one call. React state is confined to transient UI concerns (e.g., focus-ring scope); turn state is never mirrored into React state.
- Route indicator: `TugChoiceGroup` with items `[">", "$", ":"]`. Bidirectional sync:
  - Input → indicator: `<TugPromptInput onRouteChange={...}>` writes indicator value via a direct DOM ref write per [L06] (no React re-render).
  - Indicator → input: clicking a segment calls a new delegate method `delegate.setRoute(char)` that clears + inserts the route atom at position 0 (`clear()` + `insertText(char)` triggers the existing route-atom detection path).
- Submit/stop button: single `TugPushButton` whose label, icon, and disabled state come from CSS attribute selectors driven by `data-phase={snap.phase}` and `data-empty={isEmpty ? "" : undefined}` on the entry root. Per [L06]/[L15], all visual state is token-driven; no conditional JSX for "Send" vs "Stop" labels (the label sits in `::before` content from a token). The click handler dispatches `store.send(...)` or `store.interrupt()` based on `snap.canInterrupt`.
- Queue indicator: `snap.queuedSends > 0` flips a `data-queued` attribute that surfaces a small badge beside the button. No React state.
- Focus affordance: Cmd+K (or user-chosen shortcut) focuses the input via delegate; the Tide card registers a global keyboard handler that forwards to the entry's delegate.
- `/` dispatch hook: before calling `store.send()`, inspect the serialized atoms. If the first non-route atom is a local `:`-surface command (e.g. `:help`), short-circuit into a local handler rather than writing to `CODE_INPUT`. The list of local commands is provided by a small registry the Tide card owns; the surface built-ins phase (T10) populates it. Until then the registry is empty and everything routes through `CODE_INPUT`.
- `tug-prompt-input` remains unchanged in this sub-step except possibly adding `delegate.setRoute(char)` as a tiny method on the imperative handle (if `clear()` + `insertText()` proves insufficient).

**Exit criteria:**
- Component is tokenable: opening the Theme Gallery for `--tug7-*-prompt-entry-*` shows full compact/expanded pairings; `bun run audit:tokens lint` exits 0.
- Vitest suite renders the component against a mock `CodeSessionStore`, drives phase transitions, and asserts:
  - Button label/icon change via CSS selector match on `data-phase`.
  - Submit becomes Stop on `canInterrupt` and dispatches `store.interrupt()`.
  - Typing ">" in an empty input fires `onRouteChange(">")` and the indicator's DOM reflects it.
  - Clicking the `$` segment calls `delegate.setRoute("$")` and the input's first character is the `$` route atom.
  - `snap.queuedSends` changes are reflected purely via `data-queued` without a React state update in the component.
- Conforms to the component authoring guide checklist.
- **No gallery card is added** per D-T3-04.

**Status: ✓ LANDED.** Implemented via [`tugplan-tug-prompt-entry`](tugplan-tug-prompt-entry.md). `TugPromptEntry` (`tugdeck/src/components/tugways/tug-prompt-entry.tsx` + `.css`) composes `TugPromptInput` + `TugChoiceGroup` + `TugPushButton`, subscribes to a `CodeSessionStore` via `useSyncExternalStore`, and surfaces `data-phase` / `data-empty` / `data-queued` / `data-errored` attributes per [L06] / [L15]. Submit and interrupt share a single `TugPushButton` whose click handler branches on `snap.canInterrupt` [D05]; a `localCommandHandler` prop provides the command-registry seam for T10 [D06]. Route state is the only React state in the component [D04]; the input's `delegate.setRoute(char)` method drives indicator → input sync. Two gallery cards ship alongside the component (supersedes the D-T3-04 "no gallery card" line via [D07] in the plan): a pristine `gallery-prompt-entry` and an interactive `gallery-prompt-entry-sandbox` with SYNTHETIC frame factories from `MockTugConnection`. 2086/2086 tugdeck tests green; `bun run check` clean; no theme-file edits [D11]. **Handover to T3.4.c:** the component is purely a composition surface — T3.4.c's Tide card supplies real `codeSessionStore` / `sessionMetadataStore` / `historyStore` / `fileCompletionProvider` / `localCommandHandler` props and mounts the entry in the card body without touching the component's TSX or CSS.

---

##### T3.4.c — Tide card (functional registration) {#t3-4-c-tide-card}

**Goal:** Register `tide` as a full card type in the card registry, alongside `git` and `hello`. This is the Tide card — the Unified Command Surface envisioned in the Vision section of this document — in its first shippable form.

**Baseline contract (READ FIRST):**

The Tide card is built by **copying `tugdeck/src/components/tugways/cards/gallery-prompt-entry.tsx` in total** as the starting baseline. The gallery card has been progressively hardened with features the production card *requires* and that *must not be re-implemented from scratch*:

- Maximize toggle + persistence + size-writer gating (content sizer + submit-time restore stand down while maximized).
- Editor settings popover (Font / Size / Tracking / Leading) with the `topLabel` caption pattern.
- Atom rendering with `@font-face` embedding via `tug-atom-fonts`.
- Route gutter (chevron `❯` display, `>` typed alias, per-route draft persistence).
- Content-driven panel sizing via `useContentDrivenPanelSize`, gated on `!maximized`.
- Submit-time animated snap-back via `handleBeforeSubmit`, gated on `!maximized`.
- Status row layout: project badge on the leading edge, maximize toggle then settings gear on the trailing edge.
- `ResponderScope` with all four popup bindings (font / size / tracking / leading) routed to `editorStore`.
- Per-card `TugcardPersistence` wiring (route + per-route drafts + maximized state).
- `TugSplitPane` + `TugSplitPanel` shape (split-pane structure unchanged).
- Completion provider plumbing (file `@`, command `/`).

**Anything in the snippets below that conflicts with the gallery card loses; the gallery card is the source of truth.** The work in T3.4.c is to replace gallery-only seams with real backend services, not to redesign the card body.

**Work:**

Files:
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (new — `cp` of `gallery-prompt-entry.tsx` with the substitutions enumerated below).
- `tugdeck/src/components/tugways/cards/tide-card.css` (new — `cp` of `gallery-prompt-entry.css` if such a file exists; otherwise omit).
- `tugdeck/src/main.tsx` (edit: call `registerTideCard()` alongside `registerGitCard()`).

Substitutions to make on the copy:

| Gallery seam | Tide replacement |
|---|---|
| `MockTugConnection`-backed `CodeSessionStore` (mock session provider) | Real per-card `CodeSessionStore` constructed by `useTideCardServices(cardId)`. |
| Fixture `SessionMetadataStore` (`getFixtureSessionMetadataStore()`) | Shared lazy singleton `SessionMetadataStore`. |
| Fixture `PromptHistoryStore` | Shared lazy singleton `PromptHistoryStore`. |
| Fixture file completion provider | Real `FILETREE`-backed file completion provider. |
| Fixture slash command provider | Real provider merging `SessionMetadataStore.slashCommands` and skills. |
| `"Project path /gallery/demo"` `TugBadge` | `TugBadge` showing the card's actual `project_dir`. |
| Card-frame placeholder split (gallery's top panel is an empty rectangle) | `TideTranscriptHost` mounting `TugListView` over a `TideTranscriptDataSource` — multi-turn `(user, code)` row pairs plus the live in-flight pair when `inflightUserMessage !== null`. (Originally a single-region `TugMarkdownView`; replaced by [`tugplan-tug-list-view.md`](tugplan-tug-list-view.md) Step 11.) |
| `storageKey="gallery.prompt-entry"` on `TugSplitPane` | `storageKey={\`tide.card.${cardId}\`}`. |
| Gallery `data-testid="gallery-prompt-entry"` | Tide-appropriate test id (or remove). |

Everything else in `gallery-prompt-entry.tsx` carries over **verbatim** — the maximize state + effect, the `useContentDrivenPanelSize` call gated on `!maximized`, `handleBeforeSubmit` gated on `!maximized`, the `useResponderForm` with all four popup slots, the `editorStore.bind` call, the `LETTER_SPACING_OPTIONS` / `LINE_HEIGHT_OPTIONS` / `EDITOR_FONT_OPTIONS` / `FONT_SIZE_OPTIONS` arrays, the entire `toolsContent` JSX with `topLabel` on every popup, the `statusContent` badge render, and all four wiring props on `<TugPromptEntry>` (`statusContent`, `toolsContent`, `maximized`, `onMaximizeChange`). If a feature is in the gallery card, it ships in the Tide card.

Card content shape (after substitutions — illustrative, not authoritative):

```tsx
export function TideCardContent({ cardId }: { cardId: string }) {
  const services = useTideCardServices(cardId);
  // ... maximize state, useContentDrivenPanelSize({ enabled: !maximized }),
  // handleBeforeSubmit (gated), useResponderForm with all four slots,
  // editorStore.bind, status/tools content — all copied verbatim from
  // gallery-prompt-entry.tsx.
  return (
    <TugSplitPane
      orientation="horizontal"
      showHandle={false}
      disabled={maximized}
      storageKey={`tide.card.${cardId}`}
    >
      <TugSplitPanel id="tide-output" defaultSize="70%" minSize="30%">
        <TideTranscriptHost
          codeSessionStore={services.codeSessionStore}
          sessionMetadataStore={services.sessionMetadataStore}
        />
      </TugSplitPanel>
      <TugSplitPanel
        ref={entryPanelRef}
        id="tide-entry"
        defaultSize="30%"
        minSize="180px"
        maxSize="90%"
      >
        <ResponderScope>
          <TugBox /* …gallery-card layout… */>
            <TugPromptEntry
              ref={entryDelegateRef}
              id={`${cardId}-entry`}
              codeSessionStore={services.codeSessionStore}
              sessionMetadataStore={services.sessionMetadataStore}
              historyStore={services.historyStore}
              completionProviders={services.completionProviders}
              onBeforeSubmit={handleBeforeSubmit}
              statusContent={statusContent}
              toolsContent={toolsContent}
              maximized={maximized}
              onMaximizeChange={setMaximized}
            />
          </TugBox>
        </ResponderScope>
      </TugSplitPanel>
    </TugSplitPane>
  );
}
```

Registration:

```ts
export function registerTideCard(): void {
  registerCard({
    componentId: "tide",
    contentFactory: (cardId) => <TideCardContent cardId={cardId} />,
    defaultMeta: { title: "Tide", icon: "Waves", closable: true },
    defaultFeedIds: [
      FeedId.CODE_INPUT,
      FeedId.CODE_OUTPUT,
      FeedId.SESSION_METADATA,
      FeedId.FILETREE,
    ],
    sizePolicy: {
      min: { width: 480, height: 320 },
      preferred: { width: 820, height: 560 },
    },
  });
}
```

- `useTideCardServices(cardId)` is a local hook. It constructs **per-card** a `CodeSessionStore` (keyed by a per-card `sessionKey` — see below) and a per-card `PropertyStore` used as the streaming target for that card's `TugMarkdownView`. It reaches for **shared lazy singletons** for `SessionMetadataStore`, `PromptHistoryStore`, and `FileTreeStore`, following the existing `gallery-prompt-input.tsx` module-singleton pattern (`_cardServices`, `_fileTreeStore`). Per D-T3-11, the shared observers rehydrate from their snapshot feeds on (re)connect, so sharing them across cards is correct; only `CodeSessionStore` — which owns per-session turn state — is strictly per-card.
- **Session keying per D-T3-09 and Phase T0.5 P2:** `sessionKey` comes from the first `session_init` frame the store sees after mount (watch-channel snapshot per ws-verification.md T8). Until P2 ships, the first Tide card opened takes the default session and stores its `sessionKey`; subsequent cards either share that default (single-session mode, visible indicator) or are blocked from opening. Post-P2, each card's `sessionKey` routes to a distinct tugtalk supervisor session via the session_id field in frame payloads, and the cards are fully independent.
- The card inherits `tugcard-content`'s `flex: 1; overflow: auto; min-height: 0`. `TugSplitPane` already expects that shape.
- Persistence: `TugSplitPane` already persists layout via tugbank, and `TugPromptInput` already persists editing state via tugbank `[L23]`; `TugPromptEntry` persists route + per-route drafts + maximized state via `useTugcardPersistence`. The Tide card itself adds no new persistence beyond what the copied gallery card already wires. Crucially, **none of the new stores introduced in T3.4 may depend on IndexedDB (D-T3-10).** All fresh persistence goes through tugbank.

**Exit criteria:**
- `registerTideCard()` called from `main.tsx`; opening the card in the running tugdeck shows the split pane with a markdown-view top pane and a prompt-entry bottom pane.
- Default feeds `[CODE_INPUT, CODE_OUTPUT, SESSION_METADATA, FILETREE]` are subscribed on card mount and released on close.
- Split-pane layout persists across reload; bottom pane collapsible via snap-to-close.
- Opening the card for the first time with no prior state shows the `preferred` size.
- **Every gallery-card feature listed in the baseline contract above is present and working in the Tide card** — maximize toggle (with persistence), all four editor-settings popups with `topLabel`, atom font embedding, route gutter with `>`/`❯` alias, content-driven sizing gated on maximize, status-row layout. Reviewer must spot-check each item; missing any one is a failed exit.

---

##### T3.4.d — Polish & exit criteria (folded from old T3.5) {#t3-4-d-polish-exit}

**Goal:** Everything needed to declare Phase T3 done.

**Work & exit criteria (T3 overall):**

Tide card polish (deferred from T3.4.c Step 5 — `TugMarkdownView` wire-up):
- **Transcript rendering in the top pane.** Step 5 wires `inflight.assistant` only; once `turn_complete(success)` clears the streaming path, the final text of the *last* turn stays visible because the observer skips empty writes, but prior turns in `snap.transcript` do not render. Add a transcript-rendering path so multi-turn conversations accumulate in the top pane (likely a region-per-`TurnEntry` through `TugMarkdownView`'s imperative `setRegion` handle, with `stream` reserved for the in-flight turn).
- **Thinking and tool surfaces.** `streamingPaths.thinking` and `streamingPaths.tools` are unwired in Step 5. Decide the visual placement (inline in the transcript, collapsible alongside assistant text, or a dedicated subpane) and wire them. Aligns with [Phase T1](#content-block-types)'s thinking-block (U6) and tool-use-display (U7) work — pick a surface that won't need to be thrown away when T1 lands.
- **Styling the rendered markdown to look good.** The Step 5 wire-up renders through `TugMarkdownView` with default `--tugx-md-*` styling. Tuning typography, spacing, code-block chrome, and overall rhythm for Claude Code output is a dedicated pass. Shares work with [Phase T1](#content-block-types) — coordinate so T1's GFM/TugCodeBlock polish lands in sync rather than relitigating the same tokens twice.
- **Clearing the view on `turn_complete`.** Step 5's behavior is "sticky last turn" — after a successful turn, the final text remains visible until the next turn replaces it. This was the deliberate simplification in Step 5; revisit once transcript rendering lands, because the sticky behavior becomes redundant (and possibly confusing) when the finalized turn is in the transcript.
- **Status-row label.** The placeholder `statusContent` in `tide-card.tsx` hard-codes `"Project path /gallery/demo"` — a gallery-copy artifact. Replace with the bound `projectDir` (or a shortened form) from the card's binding / snapshot.

End-to-end round-trip:
- Type `> hello` → `CodeSessionStore.send` writes `user_message` on `CODE_INPUT` → `assistant_text` deltas arrive on `CODE_OUTPUT` → `TugMarkdownView` renders streaming output in the top pane → `turn_complete(success)` → entry returns to idle.
- Mid-stream Stop → `interrupt` frame on `CODE_INPUT` → `turn_complete(error)` → phase `interrupted → idle`, accumulated text preserved (Test 6).
- Mid-stream `user_message` sends → queued → auto-flush on idle (U19).
- `tool_use` and `tool_use_structured` events drive the `tool_work` sub-state; the submit button remains in Stop mode throughout.
- `control_request_forward` with `is_question: false` surfaces a permission block in the output pane; approving or denying writes a `tool_approval` frame and resumes the turn.
- `control_request_forward` with `is_question: true` surfaces a question block; answering writes a `question_answer` frame.

Feature coverage:
- `>`, `$`, `:` routes dispatch to the correct target. Today only `>` has a live target; `$` is inert (pre-tugshell) and `:` routes through the local surface registry (empty at T3 exit, populated in T10).
- Route indicator ↔ route atom stay bidirectionally synced.
- `@` file completion returns `FILETREE`-backed results and inserts file atoms.
- `/` slash command completion merges `SessionMetadataStore.slashCommands` and skills.
- History navigation (Cmd+Up/Down) works per-route from `PromptHistoryStore`.

Quality:
- CJK end-to-end (Japanese, Chinese) verified — IME compose → submit → streamed response.
- VoiceOver announces atoms, route indicator, and the submit/stop button correctly.
- Cmd+K (or chosen equivalent) focuses the prompt input from anywhere in the card.
- Atom drag-and-drop from Finder into the Tide card produces file atoms.
- No jank during typeahead over full-project file listings.

Multi-session (gated on Phase T0.5 P2 — the next work item):
- Two Tide cards open simultaneously run two independent `CodeSessionStore` instances against two distinct backing sessions, each keyed by its own `sessionKey` and filtering/tagging frames by session_id per the approved P2 wire contract.
- Submitting in one card does not affect the phase, streaming, or queue of the other.
- Until P2 lands, single-session mode is acceptable: the first Tide card captures the default session, any second card is blocked or explicitly shares with a visible single-session indicator. **This is the only T3.4 exit criterion that is deliberately gated on P2; everything else above is achievable without it.**

Compliance:
- All new/changed components pass the component authoring guide checklist.
- All new tokens conform to the seven-slot naming convention.
- `bun run audit:tokens lint` exits 0.
- Vitest + Rust nextest suites pass with `-D warnings`.
- **No new IndexedDB dependencies introduced (D-T3-10).** Any new persistence goes through tugbank.

---

### Phase T1: Content Block Types {#content-block-types}

**Status:** Shipped via [tugplan-tide-assistant-rendering.md](./tide-assistant-rendering.md). All body kinds, tool wrappers, dispatch, and assistant chrome listed below were authored, conformance-checked, and integration-tested under that plan; see its [Phase Exit Criteria](./tide-assistant-rendering.md#exit-criteria) for the verification record and the deferred-at-exit list.

**Goal:** Rich rendering for all content types in the unified output stream. This is the block rendering engine that serves both Claude Code conversation content and shell command output. Built on the Phase 3A virtualization engine (BlockHeightIndex, RenderedBlockWindow, WASM pipeline, SmartScroll).

**Covers:** U1 (text accumulation), U5 (streaming indicator), U6 (thinking display), U7 (tool use display) from tug-conversation.md.

**Work:**

Markdown content types (extending the WASM pipeline):
- GFM markdown: paragraphs, headings, emphasis, links, images, lists, tables, blockquotes, horizontal rules. All pulldown-cmark block types.
- TugCodeBlock: syntax highlighting (evaluate Shiki WASM or lighter alternatives). Copy-to-clipboard, language label, line numbers, collapse/expand. Lazy — only highlight blocks in viewport.
- `--tugx-md-*` token aliases, `@tug-pairings` per L16/L19.
- `tug-*` custom block extension point for adapter-specific renderers.

Claude Code content types (rendering events from the stream-json protocol):
- Streaming text accumulation (U1): `assistant_text` deltas accumulated, verified on `complete`.
- Streaming cursor (U5): positioned at end of last block during partials, removed on `turn_complete`.
- Thinking block (U6): `thinking_text` events → collapsible block. "Thinking..." during stream, full text when complete.
- Tool use display (U7): `tool_use` → `tool_result` → `tool_use_structured`. Tool name, input, output, duration. Collapsible. Rich structured results for Read (file viewer), Bash (stdout/stderr separation), Edit (diff view).

Shell content types (rendering events from tugshell — stubs until Phase T4 delivers shell events):
- MonospaceBlock: styled text with ANSI SGR colors mapped to CSS. The fallback for unrecognized commands.
- Typed adapter blocks: GitStatusBlock, BuildOutputBlock, FileListBlock, etc. — component interfaces defined here, populated in Phases T6/T7.

**Exit criteria:**
- All standard GFM markdown renders correctly.
- Code blocks: syntax highlighting for top-20 languages. Lazy viewport-only highlighting.
- Thinking, tool use, and streaming blocks render correctly with Claude Code events.
- MonospaceBlock renders styled text with ANSI color support.
- Adapter block interfaces defined and rendering with stub/mock data.
- Gallery card demonstrates all content types.

---

### Phase T4: Shell Bridge (Tugshell) {#shell-bridge}

**Goal:** Build tugshell — the process that bridges bash/zsh to tugcast, analogous to tugcode for Claude Code.

**Work:**
1. Shell process spawning with hidden pty, login interactive mode (`zsh -li`)
2. Shell integration hook injection (preexec/precmd for zsh, PROMPT_COMMAND/DEBUG for bash)
3. OSC 133 marker emission for command boundary detection
4. Command string capture, exit code, duration, cwd tracking
5. Raw stdout/stderr capture from pty
6. Event emission to tugcast via new ShellOutput feed (0x60)
7. ShellInput feed (0x61) for receiving commands from the UI
8. Process lifecycle management (kill on tugcast shutdown, no zombies)

**Exit criteria:**
- User types a command in tugdeck, it executes in a real shell
- `command_start` / `command_output` / `command_complete` events arrive in tugdeck with correct metadata
- Raw stdout captured and delivered as text blocks
- Shell environment (PATH, aliases, functions) fully loaded from user's startup files
- cwd tracking works across cd commands
- No orphaned shell processes on quit

---

### Phase T2: Shell Command Blocks {#shell-command-blocks}

**Goal:** The graphical components for the highest-value shell command adapters. These are the renderers that make `$ git status` look like a purpose-built app, not terminal text. Built after T4 delivers real shell events — until then, raw output is dumped unformatted.

**Work:**

| Component | Renders | Interactive Features |
|-----------|---------|---------------------|
| GitStatusBlock | Staged/unstaged file lists, branch, ahead/behind | Status icons, clickable file paths |
| GitLogBlock | Commit timeline with author, date, message, refs | Clickable hashes, branch labels, scrollable |
| GitDiffBlock | Side-by-side or unified diff | Syntax highlighting, expand/collapse hunks |
| BuildOutputBlock | Compiler errors, warnings, test results | Clickable source locations, pass/fail counts |
| FileListBlock | Directory listing with icons, metadata | Sortable columns, size/date/permissions |
| SearchResultBlock | Grouped matches with context | Highlighted matches, clickable file:line |
| DiskUsageBlock | du/df output as bars or treemap | Sortable, drill-down |

Each component:
- Accepts typed structured data (not raw text)
- Has a clear data interface matching the adapter output schema from Phase T5/T6
- Falls back gracefully if data is malformed
- Respects theme tokens and Tuglaws

**Exit criteria:**
- Each component renders correctly with mock structured data.
- Components are interactive where appropriate.
- Gallery card shows all components with representative data.

---

### Phase T5: Adapter Registry + Fallback {#adapter-registry}

**Goal:** Build the command adapter dispatch system. This is the layer that transforms raw shell output into typed, structured events.

**Work:**
1. Adapter registry: maps `(command_name, args)` → adapter function
2. Command string parser: extract command name from preexec string, detect pipes, detect redirections
3. Adapter dispatch: before command runs, check registry. For recognized commands, may run structured variant (e.g., `git status --porcelain=v2`) instead of/alongside the raw command.
4. ANSI SGR → CSS mapping for the monospace fallback renderer
5. Redirect detection: parse command string for `>`, `>>`, `2>`, show annotation
6. Exit code display: non-zero codes highlighted, `pipestatus` per-stage on failure

**Exit criteria:**
- Recognized commands produce typed structured output events
- Unknown commands fall back to MonospaceBlock with ANSI color support
- Redirected commands show redirect annotations
- Pipeline exit codes shown per-stage
- Adapter parsing failures never produce blank output — always fall back to monospace

---

### Phase T6: Core Adapters (Tier A) {#core-adapters}

**Goal:** Adapters for commands with native structured output. Highest value, lowest effort.

**Priority order** (by usage frequency × rendering value):
1. `git status` — `--porcelain=v2` → GitStatusBlock
2. `git log` — `--format=<structured>` → GitLogBlock
3. `git diff` — unified diff parsing → GitDiffBlock
4. `cargo build` / `cargo test` — `--message-format=json` → BuildOutputBlock
5. `docker ps` / `docker images` — `--format '{{json .}}'` → sortable tables
6. `npm ls` / `npm test` — `--json` → dependency tree, test results
7. `curl` — `-w '%{json}'` → response viewer

**Exit criteria:**
- Each adapter invokes the structured variant and produces typed output
- Output renders via the corresponding component from Phase T2
- Fallback to monospace if structured invocation fails
- git adapter alone covers ~20% of typical shell usage

---

### Phase T7: Filesystem Adapters (Tier B) {#filesystem-adapters}

**Goal:** Adapters for filesystem and search commands. These bypass pty output and query the filesystem directly where possible.

1. `ls` / `eza` — direct stat() → FileListBlock (icon-rich grid, sortable)
2. `grep` / `rg` — `rg --json` or parse match format → SearchResultBlock
3. `find` / `fd` — path list → file tree or flat list
4. `cat` / `bat` — read file directly → syntax-highlighted viewer
5. `du` / `df` — parse columnar output → DiskUsageBlock

---

### Phase T8: Pipe & Redirect Support {#pipe-redirect}

**Goal:** Full pipeline and redirection semantics in the unified surface. Pipes and redirects are the credibility test — the feature that determines whether experienced developers treat Tide as a real shell environment or a toy. `ls | grep foo`, `cargo build 2>&1 | tee build.log`, `git log --oneline | head -20` must work naturally and render well.

**Work:**
1. Pipeline command string parsing (split on `|`, handle quoting edge cases)
2. Run full pipeline natively through hidden pty — don't intercept intermediate stages
3. Per-stage adapter awareness: recognize `git log | head` as git output, truncated; `ls | grep foo` as filtered file listing
4. `pipestatus` array display on failure
5. Redirect detection and annotation ("Output written to build.log" with file link)
6. Background job awareness: `$ sleep 100 &` shows in a job list
7. Shell completion integration: leverage zsh compsys for contextual suggestions

---

### Phase T9: Conversation Wiring {#conversation-wiring}

**Goal:** Wire the Claude Code conversation loop end-to-end through the unified surface. Addresses U2, U3, U4, U8, U14, U23 from tug-conversation.md.

**Work:**
- Submit `>` prompts as `user_message` via CodeInput feed. Stop button sends `interrupt` (U4).
- Permission dialog (U2): `control_request_forward` with `is_question: false`. Show tool name, input, reason. Allow/deny buttons. Permission suggestions for "always allow."
- AskUserQuestion dialog (U3): `control_request_forward` with `is_question: true`. Render questions with options, single/multi-select. Respond with `question_answer`.
- Subagent activity display (U8): `tool_use: Agent` brackets subagent lifetime. Nested tool calls visible. Show agent type and progress.
- Session handling (U14): detect pending session IDs (`"pending"`, `"pending-fork"`). Wait for non-pending ID before enabling input.
- Task progress display (U23): `system:task_started/progress/completed` events for agent lifecycle indicators alongside U8.

**Exit criteria:**
- Full round-trip: type `>` prompt → streamed markdown response with thinking + tool use
- Permission and question dialogs work end-to-end
- Interrupt stops streaming, shows accumulated text
- Subagent activity visible
- Session new/fork handled cleanly

---

### Phase T10: Surface Built-Ins {#surface-built-ins}

**Goal:** Implement all `:` commands — the Tide surface's own built-in functionality. This is the unified replacement for tug-conversation.md items U9-U11, U16-U17, U20-U22, C1-C4, C10-C15.

**Work:**

| Command | What It Does | Data Source | Covers |
|---------|-------------|-------------|--------|
| `:model [name]` | Switch Claude Code model, show current | Send `model_change`; `system_metadata` | U9, C2 |
| `:permission [mode]` | Switch permission mode, cycle through | Send `permission_mode` | U10, C3 |
| `:cost` | Show cost/token display | Cached `cost_update` events | U11, C1 |
| `:status` | Show session, model, context, tools | Cached `system_metadata` + `cost_update.usage` | C1 |
| `:clear` | Start new Claude Code session | Send `session_command: "new"` | C4 |
| `:theme [name]` | Switch visual theme | Surface state | C14 |
| `:compact [focus]` | Trigger compaction with optional focus | Invoke `/compact` skill | C10 |
| `:help` | Show help, available commands | Surface state | C15 |
| `:vim` | Toggle vim keybinding mode in input | Surface state | C13 |

Additional indicators (not commands, but surface chrome):
- API retry indicator (U16): `api_retry` events — attempt count, delay, error type
- Compaction indicator (U17): `compact_boundary` events
- Plan mode choices (U20): approve/reject/keep-planning after `EnterPlanMode`
- Stop background task (U21): `{ type: "stop_task", task_id }` button
- Context window budget (U22): ~20% startup overhead in token counter

**Exit criteria:**
- All `:` commands work via the prefix router
- Model and permission mode switch correctly, surface reflects changes
- Cost and status display accurate and current
- Indicators visible when events arrive

---

### Phase T11: Session & Advanced {#session-advanced}

**Goal:** Session management, remaining command reimplementations, and advanced features. Covers C5-C9, C11-C12, U15, U18 from tug-conversation.md.

**Work:**
- `:session list` / `:session resume [id]` (C5): session picker — list, preview, rename, filter
- `:session fork` / `:session branch` (C12): fork current session via `session_command: "fork"`
- `:session rename [name]` (C11): update session metadata
- `:export` (C7): serialize conversation from accumulated events
- `:copy` (C8): copy last assistant response to clipboard
- `:btw [question]` (C9): side question — separate API call, no history impact. Renders as ephemeral overlay.
- `:diff` (C6): run git diff, render with GitDiffBlock from Phase T2
- Image attachments (U15): base64 in `user_message.attachments`. Drag-drop/paste into `>` prompt.
- Session-scoped permission reset (U18): re-prompt for permissions after session resume.

**Exit criteria:**
- Session picker works (list, resume, rename, fork)
- Image attachments work via drag-drop/paste
- Export and copy functional
- Side question (/btw) renders as ephemeral overlay
- Permissions re-prompt correctly after session resume

---

### Phase T12: Environment Sync {#environment-sync}

**Goal:** Shell and Claude Code share working directory and environment context — the glue that makes the unified surface feel like one environment, not two.

**Work:**
1. cwd tracking: shell `cd` → tugshell reports new cwd → surface updates display → Claude Code's next turn picks up new cwd
2. Environment variable snapshot: shell exports available to Claude Code's Bash tool calls (tugshell can snapshot the current environment)
3. Display: current cwd always visible in surface chrome
4. Bidirectional: Claude Code's Bash tool calls execute in the shell's environment context
5. Claude Code `cd` (via Bash tool): shell environment updated to match

**Exit criteria:**
- `$ cd src` in shell updates the surface cwd; next `>` prompt to Claude Code uses the new cwd
- Environment variables exported in shell visible to Claude Code tool calls
- cwd display always accurate

---

### Phase T13: Cross-Surface Interactions {#cross-surface}

**Goal:** The interactions that make the unified surface more than the sum of its parts.

1. **Shell output → Claude context**: select shell command output block, action to "send to Claude" — injects the output as context in the next `>` prompt.
2. **Claude tool output → rich rendering**: when Claude Code calls Bash (e.g., runs `cargo build`), the `tool_use_structured` output goes through the same adapter pipeline as `$ cargo build` — same BuildOutputBlock renderer.
3. **Suggested commands**: Claude Code can suggest shell commands in its response; user clicks to execute via `$` route.
4. **Error assistance**: shell command fails → surface offers "ask Claude about this error" action, pre-filling a `>` prompt with the error context.

**Exit criteria:**
- Shell output selectable and sendable to Claude Code as context
- Claude Code's Bash tool output renders with adapter components
- Click-to-execute for suggested shell commands
- Error assistance flow works end-to-end

---

### Phases F1-F5: Feed Layer {#feed-layer}

See [tug-feed.md](tug-feed.md) for full architecture. These phases add structured agent progress reporting to the unified surface.

| Phase | Goal | Scope |
|-------|------|-------|
| F1: Hook Capture | Agent lifecycle → `raw-events.jsonl` | Shell scripts + hooks.json |
| F2: Feed Correlation | Semantic enrichment → `feed.jsonl` | Correlation logic |
| F3: Feed CLI + Tugcast | `tugutil feed` + browser delivery | Rust CLI + tugcast feed (0x60) |
| F4: Agent-Internal Events | File/command detail within agents | Agent frontmatter hooks |
| F5: Custom Block Renderers | Rich agent output UI in Tide surface | React components |

---

## Research Agenda

Investigations needed before or during implementation:

### R1: Shell Hook Depth (before Phase T4)

- Verify zsh preexec/precmd capture works in practice across macOS zsh versions
- Test with complex startup files (oh-my-zsh, powerlevel10k, starship)
- Measure hook injection overhead
- Test interaction with direnv, nvm, conda environment managers
- Verify OSC 133 marker emission works through the hidden pty

### R2: Command String Parsing (before Phase T5)

- Survey existing MIT-licensed shell parsers that can extract pipeline structure
- Define the subset of shell syntax we need to parse (commands, pipes, redirects)
- Test edge cases: heredocs, quoting, multi-line commands, subshells

### R3: Adapter Feasibility (before Phase T6)

- For each Tier A command: verify structured output mode, document exact invocation
- Test that structured output matches what users expect (e.g., `git status --porcelain=v2` captures everything `git status` shows)
- Measure latency of structured invocation vs. raw command

### R4: Nushell/PowerShell Patterns (informing Phase T5)

- Study Nushell's command-to-Value mapping for adapter design patterns
- Study PowerShell's type-to-view declarative mapping for renderer dispatch
- Study Jupyter's multi-representation (MIME-type) model for output format negotiation
- **License constraint**: MIT/Apache-2.0/BSD only. No GPL.

### R5: Completion System (informing Phase T3/T8)

- Can we leverage zsh compsys completion specs for command-aware input suggestions?
- Can we use Fig/Amazon Q CLI specs (MIT) for argument structure?
- What does route-aware completion look like in practice?

---

## Item Coverage Map

Every forward-looking item from tug-conversation.md is accounted for in a Tide phase. Nothing is dropped.

### UI Must Build (U1-U23)

| Item | Description | Tide Phase |
|------|-------------|------------|
| U1 | Text accumulation (deltas → buffer) | T1 |
| U2 | Permission dialog | T9 |
| U3 | AskUserQuestion dialog | T9 |
| U4 | Interrupt button | T9 |
| U5 | Streaming indicator/cursor | T1 |
| U6 | Thinking/reasoning display | T1 |
| U7 | Tool use display | T1 |
| U8 | Subagent activity | T9 |
| U9 | Model switcher | T10 |
| U10 | Permission mode switcher | T10 |
| U11 | Cost/token display | T10 |
| U12 | Slash command popup | T3 |
| U13 | `@` file completion | T3 |
| U14 | Session new/fork handling | T9 |
| U15 | Image attachments | T11 |
| U16 | API retry indicator | T10 |
| U17 | Compaction indicator | T10 |
| U18 | Session-scoped permission reset | T11 |
| U19 | Message queueing during turn | T3 |
| U20 | Plan mode choices | T10 |
| U21 | Stop background task | T10 |
| U22 | Context window budget | T10 |
| U23 | Task progress events | T9 |

### Terminal-Only Commands (C1-C15)

| Item | Command | Tide Phase |
|------|---------|------------|
| C1 | `/status` | T10 (`:status`) |
| C2 | `/model` | T10 (`:model`) |
| C3 | `/permissions` | T10 (`:permission`) |
| C4 | `/clear` | T10 (`:clear`) |
| C5 | `/resume` | T11 (`:session resume`) |
| C6 | `/diff` | T11 (`:diff`) |
| C7 | `/export` | T11 (`:export`) |
| C8 | `/copy` | T11 (`:copy`) |
| C9 | `/btw` | T11 (`:btw`) |
| C10 | `/compact` | T10 (`:compact`) |
| C11 | `/rename` | T11 (`:session rename`) |
| C12 | `/branch`, `/rewind` | T11 (`:session fork`) |
| C13 | `/vim` | T10 (`:vim`) |
| C14 | `/color`, `/theme` | T10 (`:theme`) |
| C15 | `/help` | T10 (`:help`) |

### Exploration Areas (E1-E6)

| Item | Area | Status |
|------|------|--------|
| E1 | Slash command invocation | Resolved (T1, T2 in Phase 2) |
| E2 | Plugin system | Resolved |
| E3 | Hooks visibility | Deferred — non-blocking |
| E4 | Tugcast WebSocket layer | Resolved (Phase 2b/2c) |
| E5 | Session management | T11 |
| E6 | Advanced patterns (background, MCP) | Deferred — non-blocking |

---

## Open Design Questions

1. **Default route when no prefix**: Should the surface infer intent (natural language → Claude, command-like → shell), or require an explicit prefix? Inference is convenient but error-prone. Explicit is unambiguous but adds friction.

2. **Claude Code Bash tool rendering**: When Claude Code runs a Bash tool call, should the output go through the adapter pipeline? This would make `cargo build` look the same whether the human or Claude ran it. But it means the adapter must handle raw stdout from the tool result, not from tugshell's pty. (Addressed in T13 but design TBD.)

3. **Job control**: Background jobs (`$ sleep 100 &`) need representation. A job list panel? Inline status? How does this interact with Claude Code's background agents?

4. **Session model**: Is a Tide session one shell + one Claude Code session? Can you have multiple of each? How does session persistence work — resume both shell history and Claude Code conversation?

5. **Remote execution**: Tide surfaces could connect to remote machines. The shell bridge could spawn an SSH session instead of a local shell. How does this affect the adapter model?

6. **Mobile/tablet**: Is the prefix routing model usable on mobile where typing special characters is harder?

7. ~~**Tugcast vs. local for the shell bridge**~~: **Resolved — tugcast for everything, always.** One architecture, one implementation of tugshell. The WebSocket connection between tugdeck and tugcast is already network-transparent — tugdeck doesn't know or care whether tugcast is on localhost or across the internet. If tugshell goes through tugcast the same way tugtalk does, then remote use comes for free: tugcast, tugtalk, and tugshell run on a remote machine (or cloud VM, or dev container); tugdeck in the browser connects over the network; everything works the same. The latency concern is overstated — the localhost hop (tugshell → tugcast → WebSocket → tugdeck) adds microseconds on top of commands that take tens of milliseconds. Interactive typing and tab completion are handled by the surface itself, not round-tripped through tugshell.

---

## Risks

### Adapter edge cases

The adapter model assumes you can reliably identify what command is running and intercept its output. For simple commands (`git status`, `cargo build`) this is straightforward. It gets harder with:

- **Aliases**: `alias gst='git status'` — the adapter sees `gst`, not `git status`, unless it resolves aliases. Zsh's `preexec` third argument provides alias-expanded text, which helps. Bash does not.
- **Pipelines**: `git status | head` — is this a git command or a head command? The adapter must parse the pipeline string and decide which stage to recognize. The pragmatic answer (recognize the *first* command in the pipeline, render the *final* output) handles most cases.
- **Shell functions**: User-defined functions that wrap commands. The adapter sees the function name, not the underlying commands. Similar to the alias problem.
- **Complex command lines**: Heredocs, nested quoting, subshells, command substitution — the command string from `preexec` is unparsed text, not an AST. Parsing it correctly for all edge cases is hard.

**Mitigation**: Invest heavily in the fallback path. Styled monospace text with ANSI color support must be genuinely good — not an afterthought. When the adapter can't figure out what a command is, the fallback should render the output attractively and usefully. If the fallback is good, adapter edge cases are cosmetic annoyances, not broken experiences.

### Scope

The roadmap has 13 Tide phases plus 5 feed phases. The Claude Code side alone (T1, T3, T9-T11) is substantial. The shell side (T4-T8) is a new codebase. The unification (T12-T13) is where the magic happens but also where the integration complexity lives.

**Mitigation**: The phasing is designed so that a Claude Code-only surface (T1 + T3 + T9) is shippable on its own. The shell side can come later. The full vision requires both halves, but value accrues incrementally.

### Shell integration compatibility

Shell hooks (preexec/precmd) must coexist with existing shell frameworks: oh-my-zsh, powerlevel10k, starship, direnv, nvm, conda. Any of these could conflict with our hook injection. The OSC 133 marker technique is battle-tested (iTerm2, Warp, VS Code all use it), but each environment adds variables.

**Mitigation**: Research item R1 specifically targets this. Test with real-world shell configurations before committing to the hook injection approach.

---

## Deferred

- **tug-rich-text** — Monaco editor wrapper. Future.
- **tug-search-bar** — TugInput + TugButton. Future.
- **Tiptap migration** for prompt input (@-mentions, ghost text). Future.
- **Mermaid, KaTeX** — markdown extensions via extension point. When needed.
- **E3 (hooks visibility)** — Hooks run silently. Non-blocking.
- **E6 (advanced patterns)** — Background tasks, MCP, elicitation. Non-blocking.
- **Learning height estimator** — converge on measured heights. Future enhancement.
- **Shell completion integration** — leveraging zsh compsys from the graphical surface. Research item R5.

---

## Resolved Questions

1. **Streaming text model** — Deltas on partials, full text on complete. UI accumulates. (Phase 1 finding)
2. **Slash command invocation** — Works via `user_message`. Fixed with T1+T2. (Phase 2 fix)
3. **Process lifecycle** — Process groups, parent-death watchdog, kill_on_drop. (Phase 2 fix)
4. **Production Bun dependency** — Eliminated. Tugtalk standalone binary. (Phase 2 fix)
5. **WebSocket path** — Fully verified. Wire protocol documented. Issues T8-T11 fixed. (Phase 2b/2c)
6. **Markdown performance** — pulldown-cmark WASM: 1MB in 14ms. Workers removed. (Phase 3A.4)
7. **Scroll management** — SmartScroll: six-phase state machine, follow-bottom, all input methods. (Phase 3A.6/3A.7)
8. **Project codename** — "Tide" for the unified command surface vision. Tugdeck remains the rendering implementation. Rejected alternatives: "tug-conversation" (too narrow — was right when scope was just Claude Code chat), "single surface" (describes the concept, not the thing), "graphical terminal" (contradictory — the whole point is shedding the terminal), "tugdeck" (it's a bigger concept, keep them separate — Tide is the vision, tugdeck is the implementation), "helm" (overloaded — Kubernetes), "tug-bridge" (confuses with software bridge pattern).
9. **Tugcast for everything** — All backends go through tugcast. One architecture, one WebSocket. Network-transparent by default, so remote use comes for free. Localhost latency overhead is negligible.
10. **Naming cleanup** — Rename plan finalized. tugtalk → **tugcode** (Claude Code bridge). tugcode (CLI) → **tugutil** (all-purpose utility). tugtool (launcher) → **`tugutil serve`** subcommand. tugtool-core → **tugutil-core**. Workspace directory `tugcode/` → **`tugrust/`**. Convention: `tug{suffix}` where suffix names the facility. Phase T0 tracks the work.
11. **Tugcast routes opaquely** — Tugcast forwards frames by FeedId without interpreting JSON payloads. Event type semantics live in tugdeck and the bridge processes, not in the multiplexer. This is what makes the architecture extensible — adding a new service is a new bridge + new FeedId pair, not a tugcast change.

---

## Relationship to Existing Work

| Component | Role in Tide | Status |
|-----------|-------------|--------|
| **tugcast** | WebSocket multiplexer, binary framing, opaque feed routing | Existing, needs new FeedIds |
| **tugcode** (currently tugtalk) | Claude Code bridge (stream-json ↔ tugcast) | Existing, proven. Rename in Phase T0. |
| **tugshell** | Shell bridge (bash/zsh ↔ tugcast) | **New** |
| **tugutil** (currently tugcode CLI) | All-purpose utility: state, worktree, validate, serve | Existing. Rename in Phase T0. Absorbs tugtool launcher. |
| **tugdeck** | Graphical rendering surface | Existing, needs unified output stream |
| **tugapp** | macOS app (product name: "Tug") | Existing |
| **tug-feed** | Agent progress event layer | Planned, integrates with Tide |
| **tugplug** | Claude Code plugin (skills, agents) | Existing, unchanged |
| **tugbank** | SQLite defaults database + CLI | Existing, unchanged |
| **tugrust/** (currently tugcode/) | Rust workspace directory containing all crates | Existing. Rename in Phase T0. |

---

## Sources

- [tide-conversation-log.md](tide-conversation-log.md) — Full design conversation (2026-04-02)
- [tug-conversation.md](tug-conversation.md) — Claude Code transport exploration, UI phases, protocol documentation
- [transport-exploration.md](transport-exploration.md) — 35 tests documenting stream-json protocol
- [ws-verification.md](ws-verification.md) — WebSocket path verification
- [tug-feed.md](tug-feed.md) — Structured progress reporting architecture
- Nushell (MIT) — Structured pipeline patterns
- PowerShell (MIT) — Object pipeline, type-to-view mapping
- Jupyter kernel protocol (BSD) — Multi-representation output model
- Fig/Amazon Q CLI specs (MIT) — Command interface descriptions
