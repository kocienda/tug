# Tug — Infrastructure Stack

*A view of how the pieces fit together, for people meeting Tug for the first time.*

Tug is not one program. It is a suite of cooperating processes that, together, produce a single graphical surface where shell commands and AI conversations live side by side. This document maps the pieces and how they talk to each other.

---

## The stack at a glance

```
                     ┌──────────────────────────────┐
                     │           USER               │
                     │   (keyboard, pointer, eyes)  │
                     └──────────────┬───────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│                           Tug.app  (macOS host)                              │
│                          ─────────────────────                               │
│   AppKit shell · NSWindow · WKWebView · ProcessManager · ControlSocket       │
│   Swift   ·   supervises child processes   ·   loads tugdeck into WebKit     │
│                                                                              │
└───────────────┬───────────────────────────────────┬──────────────────────────┘
                │ spawns / supervises               │ loads HTML
                │ (control socket: UDS)             │ http://127.0.0.1:vite
                ▼                                   ▼
┌──────────────────────────────────┐   ┌──────────────────────────────────────┐
│                                  │   │                                      │
│       tugcast  (Rust)            │   │          tugdeck  (TypeScript)       │
│   ─────────────────────          │   │       ─────────────────────────      │
│   WebSocket multiplexer.         │   │   Browser frontend running inside    │
│   Owns every feed:               │   │   WKWebView. React 19 + Vite.        │
│     • code feed (claude)         │◀──┤   Connects upward to tugcast over    │
│     • shell / pty feed           │   │   ws://127.0.0.1:tugcast.            │
│     • filesystem / git feed      │   │                                      │
│     • stats feed                 │   │   Renders feed events as graphical   │
│   axum + tokio. One process.     │   │   command blocks (Tide surface).     │
│                                  │   │                                      │
└──┬───────────────────┬───────────┘   └──────────────────────────────────────┘
   │                   │
   │ stream-json over  │ pty I/O,
   │ stdio (IPC)       │ fs watch,
   ▼                   │ git, sysinfo
┌──────────────────────┴─┐   ┌───────────────────────────┐   ┌────────────────┐
│                        │   │                           │   │                │
│   tugcode  (Bun/TS)    │   │   pty / bash · zsh        │   │   tugbank      │
│  ─────────────────     │   │   ──────────────────      │   │  ──────────    │
│   Bridge to Claude     │   │   Hidden pseudo-terminal  │   │   SQLite       │
│   Code. Translates     │   │   for shell commands.     │   │   typed-       │
│   stream-json events   │   │   Adapters detect known   │   │   defaults     │
│   into the tugcast     │   │   commands and emit       │   │   store.       │
│   protocol. One        │   │   structured output.      │   │   /api/        │
│   process per session. │   │                           │   │   defaults/…   │
│                        │   │                           │   │                │
└──────────┬─────────────┘   └───────────────────────────┘   └────────────────┘
           │
           │ spawns
           ▼
   ┌──────────────────┐
   │ claude  (CLI)    │
   │ --output-format  │
   │ stream-json      │
   └──────────────────┘


┌──────────────────────────────────────────────────────────────────────────────┐
│                       Build- and Dev-time companions                         │
│                       ──────────────────────────────                         │
│                                                                              │
│   tugutil   — Rust CLI. Project mgmt, state tracking, worktree setup,        │
│               tugplan helpers, the /commit and /implement plumbing.          │
│                                                                              │
│   tugexec   — Launcher. Brings up tugcast + Vite + a browser for             │
│               headless tugdeck development (no Tug.app required).            │
│                                                                              │
│   tuglog    — Shared tracing/logging initialization for every Rust binary.   │
│                                                                              │
│   tugplug   — Claude Code plugin: agents and skills that orchestrate plan-   │
│               and-implement workflows (clarifier, author, critic, coder,     │
│               reviewer, committer, integrator, auditor, …).                  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Reading the diagram

**Top half — the running app.** Tug.app is the macOS host. It owns the window, embeds tugdeck in a WKWebView, and supervises the backend processes via a Unix-domain control socket. Everything the user sees is rendered by tugdeck inside that WebView.

**Middle — the spine.** tugcast is the WebSocket multiplexer. It is the single point through which every feed reaches the frontend: AI conversation (from tugcode), shell I/O (from the pty), filesystem and git events, system stats. tugdeck speaks only to tugcast.

**Below tugcast — the producers.** tugcode bridges Claude Code's `--output-format stream-json` into the tugcast protocol. The pty layer runs unmodified bash or zsh and, where adapters exist, emits structured events instead of raw ANSI. tugbank is the persistent-state store reachable through `/api/defaults/<domain>/<key>` — there is no `localStorage` in tugdeck.

**Bottom box — companions.** These are the build- and dev-time tools that surround the running app: the Rust CLIs (`tugutil`, `tugexec`, `tuglog`) and the Claude Code plugin (`tugplug`) that drives planning and implementation workflows.

---

## Languages and process boundaries

| Component | Language / Runtime | Process role                          |
|-----------|--------------------|---------------------------------------|
| Tug.app   | Swift / AppKit     | Host process. Owns window + WebView.  |
| tugdeck   | TypeScript / React | Runs inside WKWebView.                |
| tugcast   | Rust / tokio       | Long-lived backend. WebSocket server. |
| tugcode   | TypeScript / Bun   | Per-session bridge to `claude`.       |
| claude    | Anthropic CLI      | Subprocess of tugcode.                |
| tugbank   | Rust + SQLite      | Embedded store, accessed via HTTP.    |
| tugutil   | Rust CLI           | Developer CLI; not in runtime path.   |
| tugplug   | Markdown + tools   | Claude Code plugin, dev-time only.    |

---

## The transport story in one line

> Anything the user sees flows through tugcast as a typed JSON event. Anything the user types goes back through the same channel. The terminal is gone; the commands are not.

This is the whole point of the project. The terminal was a 1978 character grid doing two jobs — interpreting commands and rendering output. Tug splits those jobs. The interpreters (shells, Claude Code, future bridges) keep working unchanged. The rendering job moves to a real graphical surface. Everything in this diagram exists to make that split clean.
