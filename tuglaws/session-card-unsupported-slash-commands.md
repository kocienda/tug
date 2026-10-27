# Session-card unsupported slash commands

*Why some of Claude Code's slash commands don't appear in the session card's `/` popup.
This is the maintained mirror of the hidden set; the engineering doctrine — the
full three-tier model, catalog sources, decision procedure, and recipes — lives in
[slash-commands.md](slash-commands.md).*

The session card talks to `claude` over a **stream-json / print-mode** bridge — there
is no interactive terminal UI on the other end. Claude Code's slash commands fall
into three groups, and the popup shows only the first two:

- **Local commands with a Tug surface** — reimplemented graphically in the dev
  card (`/permissions`, `/model`, `/rewind`, `/resume`, `/diff`, `/context`,
  `/skills`, `/agents`, `/memory`, `/hooks`, `/compact`, `/usage`, `/logout`, …).
  Typing one opens its surface, and so does typing claude's alias for one
  (`/new` or `/reset` for `/clear`, `/continue` for `/resume`, `/name` for
  `/rename`, `/allowed-tools` for `/permissions`).
- **Pass-throughs** — commands that expand to a prompt and run a real model turn
  (`/init`, `/insights`, `/recap`, `/goal`), plus every skill and agent
  command. These are sent to `claude` verbatim. A typed command the session card
  doesn't recognize locally is checked against the command catalogue `claude`
  reports for the session: if `claude` knows it, it is passed through; if not,
  it is a genuine unknown (usually a typo) and the session card shows an *Unknown
  command* alert client-side instead of burning a turn. Nothing is silently
  dropped — local commands open a surface, hidden commands show a *"Command not
  available"* alert (below), pass-throughs reach `claude`, and unknowns get an
  *"Unknown command"* alert.
- **Unsupported (hidden)** — commands that do nothing useful over the bridge:
  they render terminal-only UI, set TUI state, or address an account / host /
  device concern that isn't the session card's. These are **absent from the popup**,
  and typing one shows a brief *"Command not available"* alert (it is never sent
  to `claude`) rather than silently vanishing.

The authoritative hidden set is `HIDDEN_SLASH_COMMANDS` in
`tugdeck/src/lib/slash-supported.ts`; this document mirrors it. The decision to
hide rather than grey-out, and to keep the list discoverable here, was made in
the original slash-commands plan (its plan-local decision [D14] — not an entry
in the global [design-decisions.md](design-decisions.md)); the standing doctrine
is [slash-commands.md](slash-commands.md).

## Hidden commands, by reason

### Terminal-only UI flags / view preferences
`/vim`, `/theme`, `/color`, `/tui`, `/keybindings`, `/terminal-setup`,
`/chrome`, `/focus`, `/fast`, `/status`, `/statusline`, `/scroll-speed`,
`/voice`, `/artifacts`, `/pause-memory` (aliases `/memory-pause`,
`/toggle-memory`) — these render Ink components or set terminal-local UI state; nothing
happens over a headless bridge. (`/status` is a no-op specifically because the
Z4B chrome already shows session status; `/statusline` is the same, the Z4B
chrome owns ours.)

### Conversation-structure / automation
`/branch`, `/plan`, `/autofix-pr`, `/workflows`, `/fork`, `/subtask`, `/ultraplan`,
`/ultrareview`, `/schedule` (alias `/routines`) — conversation branching,
plan mode, PR / workflow orchestration, forked subagents and subagents sent off
with the full context, cloud
plan/review, and scheduled cloud routines. Out of conversational-parity
scope; each is a substantial standalone feature for a future plan, and is
kept in the hidden registry as a marker for that future work.

`/code-review ultra` is refused for the same reason as `/ultrareview`, which
claude now calls its deprecated alias. Typed in a git repository, it starts a
billed cloud review with no confirmation. Plain `/code-review`, a local review,
passes through; only the `ultra` argument is refused.

(`/tasks` and `/bashes` graduated to Tug-local commands, and they open
different surfaces: `/tasks` the numbered checklist, `/bashes` the JOBS
popover where running shells, subagents, scheduled work, and the `/goal`
live.)

(`/goal` and `/loop` — alias `/proactive` — graduated out of this group as
pass-throughs, probe-verified on claude 2.1.204; see
[slash-commands.md](slash-commands.md) and
`tugcode/probes/goal-loop/FINDINGS.md`.)

(`/btw` — graduated to a Tug-local command. The earlier "hidden" note was
half-right: claude *does* refuse the **user-text** `/btw` over the headless
bridge ("/btw isn't available in this environment"). But `/btw` is not a
text-expanding slash command — it is a `side_question` **control-request**,
serviced by the same inbound handler as `initialize`/`interrupt`/`set_model`.
tugcode drives that control-request and renders the answer in a non-modal
overlay; probe-verified serviced idle AND mid-turn on claude 2.1.204 — see
[slash-commands.md](slash-commands.md) and `tugcode/probes/btw/FINDINGS.md`.)

### Plugin / advisor config
`/advisor`, `/plugin` (aliases `/plugins`, `/marketplace`), `/cloud-plugins`,
`/peers` — plugin configuration; a host-app or future-plan concern. (`/peers` is
claude's alias of `/list-agents`; claude offers the command headless but not the
alias.)

(`/reload-plugins` and `/reload-skills` graduated out of this group as
pass-throughs: both reload in place over the bridge on claude 2.1.311. See
`tugcode/probes/slash-parity/FINDINGS.md`.)

### Account / auth / subscription / novelty
`/login`, `/privacy-settings`, `/config` (alias `/settings`),
`/feedback` (alias `/share`), `/install-github-app`, `/install-slack-app`,
`/web-setup`, `/setup-bedrock`, `/setup-vertex`, `/upgrade`, `/passes`,
`/powerup`, `/radio`, `/stickers`, `/sandbox`, `/cost` and `/stats` (aliases of
`/usage`, which opens the card's usage sheet and is reached by that name),
`/usage-credits`, `/extra-usage`, `/team-onboarding`, `/design-login`,
`/rate-limit-options` — account, auth,
settings, provider/host setup, and subscription surfaces that belong to the
Tug.app host, not the session card. (`/logout` is the card's own: it logs out of
Claude and returns to setup.)

### Device / cross-app / teleport
`/ide`, `/desktop` (alias `/app`), `/mobile` (aliases `/ios`, `/android`),
`/remote-control` (alias `/rc`), `/remote-env`, `/background` (alias `/bg`),
`/stop`, `/teleport` (alias `/tp`), `/daemon`, `/session` (alias `/remote`) —
cross-app, device, terminal-freeing, background-service and cloud-session
commands that aren't the session card's concern. (`/cd` is
the card's own: it moves the card into another directory, carrying the
conversation.)

### Diagnostics / info / process control
`/doctor`, `/release-notes`, `/heapdump`, `/version`, `/quit`, `/exit`,
`/install`, `/restart` (alias `/update`) — install diagnostics, info display,
installing and restarting claude, and process control. Closing a card is the
session card's quit affordance.

### Disabled or hidden by claude itself
`/loops`, `/wellbeing` (aliases `/breaks`, `/break-reminder`, `/downtime`),
`/pro-trial-expired` — claude switches these off or hides them in its own
command table. Listing them keeps this set a complete account of what claude
names, and the *"Command not available"* alert is the accurate answer.

### Out of scope by prior decision
`/mcp` — MCP is fully out of scope ([Q06]); it returns when MCP is addressed in a
future plan. `/bug` — files feedback to Anthropic, which has no meaning over the
bridge.
