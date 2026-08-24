## Route Enhancements — `code | shell | btw` {#route-enhancements}

**Purpose:** Make the Dev card's route choice group real: `btw` joins as a third route with per-route Z4B chrome, and the `shell` route — cosmetic since the prompt-entry-zones phase — gains an actual block-oriented execution backend whose command/output exchanges thread into the transcript as durable, visually distinct rows.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | `main` (implemented on a `tugutil dash` worktree) |
| Last updated | 2026-07-09 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Dev card's Z4A route choice group ([D97]) has shown `Code | Shell` for months, but the Shell route is a lie: `TugPromptEntry.performSubmit` calls `codeSessionStore.send()` unconditionally — text typed on the `$` route goes to Claude Code. The `SHELL_INPUT`/`SHELL_OUTPUT` feed IDs (0x60/0x61) are reserved but unwired in both `tugdeck/src/protocol.ts` and `tugrust/crates/tugcast-core/src/protocol.rs`, and the transcript's `TurnOrigin` type reserves a `#s` shell origin it never mints (`tugdeck/src/lib/code-session-store/types.ts`). Meanwhile `/btw` side questions ([D108]) shipped as a slash command + overlay with no home in the card's conceptual model, and the Z4B chrome cluster overloads one set of chips across routes via disable-scatter (`DevRouteShellGate`).

The unifying model (decided in discussion, now plan of record): **routes are recipients**. `❯` code = Claude on the record, `$` shell = the machine, `?` btw = Claude off the record. The transcript becomes *the session's record of what happened* — no longer a strict mirror of Claude's context — with shell exchanges as visually distinct non-context rows and `/btw` remaining deliberately ephemeral (never transcript ink, per [D108]).

#### Strategy {#strategy}

- **Three phases, strictly ordered.** Phase 1 is a probe that settles the shell execution architecture ([Q01]–[Q04]) before any backend code is written — the probe-then-plan rhythm that made `dash/add-btw.md` land cleanly. Phase 2 is deck-only route/Z4B chrome work (including the `btw` route), shippable before any backend exists. Phase 3 builds the shell backend, wire, ledger, transcript threading, and rendering on the probe's findings.
- **Build up, never strip down.** The shell is block-oriented exec (command → captured output → exit code), not a TTY emulator. Capabilities are added deliberately (cwd state, env, chains); interactive TUIs are detected and declined, never half-supported.
- **Raw always renders; richness accretes.** Every command runs and renders via the generic terminal block; a curated command-block registry (the [D101] grammar) adds bespoke rendering over time.
- **Exploit the fossils.** `TurnOrigin` `#s` reservation, the reserved shell feed IDs, the shipped `$SHELL` route-identity badge branch, the `TerminalBlock` body kind, and the sqlite-ledger + CONTROL-tail-fetch pattern (`pulse_lines` / `list_pulse_lines`) are all already in the tree.
- **One reducer funnel stays sacred.** Live shell frames and restore-time ledger rows both enter the transcript through `CodeSessionStore`'s reducer, exactly as live tugcode frames and JSONL replay do today.

#### Success Criteria (Measurable) {#success-criteria}

- Typing a command on the `$` route executes it against a real shell and renders the exchange (command, output, exit code) as a transcript row — verified by an app-test driving the real app.
- A Developer ▸ Reload (and app relaunch + resume) reconstructs the transcript with shell rows interleaved at their original positions among Claude turns — verified by an app-test asserting row order across reload.
- Typing a question on the `?` route round-trips through the native `side_question` control request and renders in the existing overlay; the transcript row count is unchanged by the exchange (the [D108] invariant, already pinned by `at0211`).
- Route flips swap the Z4B chrome per the manifest (Table T01) with no layout jump within a route — geometry-asserted in an app-test.
- Zero regressions: full `bun test` (tugdeck, tugcode), `cargo nextest run`, `bunx vite build`, and the app-test suite pass at every step boundary.

#### Scope {#scope}

1. Shell execution architecture probe with committed FINDINGS.md (Phase 1).
2. `btw` as a third route: choice-group item, `?` prefix, keybinding, per-route submit dispatch (Phase 2).
3. Per-route Z4B chrome manifest replacing the `DevRouteShellGate` disable-scatter (Phase 2).
4. tugcast shell execution service + `SHELL_INPUT`/`SHELL_OUTPUT` wire + sqlite exchange ledger (Phase 3).
5. Shell exchanges as transcript rows: `shell` turn origin, `shell_exchange` Message kind, `TerminalBlock`-based rendering, restore interleave (Phase 3).
6. On-demand share gesture (compose an exchange into the prompt entry) and live cwd chip (Phase 3).
7. Command-block registry skeleton on the [D101] grammar (Phase 3).
8. Docs: global design-decision entries, tuglaws updates (Phases 2 and 3).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **TTY emulation / interactive TUIs** — no vim, htop, pagers, curses. Detected and declined gracefully.
- **Always-in-context shell sharing** — Claude never sees shell exchanges implicitly; only the explicit share gesture. Documented non-goal until someone misses it.
- **WORK-cell persistence** (pinnable WORK popover / Z0B zone) — tabled; orthogonal to routes.
- **Bespoke command renderers beyond the registry skeleton** — `git status`-style rich blocks are follow-ons; this plan ships the registry and the generic block only.
- **`/btw` transcript ink** — [D108] stands; the `?` route reuses the existing overlay surface.
- **Multi-shell / shell tabs** — one shell session per Dev card.

#### Dependencies / Prerequisites {#dependencies}

- Shipped `/btw` feature ([D108], `dash/add-btw.md`) — the `?` route dispatches into `SideQuestionStore.ask` via the existing local-command machinery.
- `tokio::process` (already a tugcast dependency) — the pipe-mode POSIX-shell child backend chosen for [Q01]/[P09] (tmux was evaluated and rejected in the probe; no tmux dependency is taken).
- `TerminalBlock` body kind (`tugdeck/src/components/tugways/body-kinds/terminal-block.tsx`) — the shell row's rendering substrate.
- sqlite ledger precedent (`tugrust/crates/tugcast/src/session_ledger.rs`) and CONTROL tail-fetch precedent (`list_pulse_lines` in `tugrust/crates/tugcast/src/feeds/pulse.rs`).

#### Constraints {#constraints}

- Rust workspace enforces `-D warnings`; all suites green at every commit boundary.
- Tuglaws apply to all tugdeck work: [L01] one render, [L02] external state via `useSyncExternalStore`, [L03] `useLayoutEffect` registrations, [L06] appearance via CSS/DOM, [L26] mount identity.
- No `localStorage`/`sessionStorage`/IndexedDB — persistent deck state goes through tugbank defaults; shell history goes through the tugcast ledger.
- HMR must never reload data/transcript; Developer ▸ Reload is the true hard refresh that re-resumes (baked-in invariant).
- App-tests run via `just app-test` from the worktree root; real measured geometry, no mocks/jsdom.

#### Assumptions {#assumptions}

- One Dev card ↔ one Claude session ↔ one shell session at a time; the shell's exchanges stamp the currently bound `tug_session_id`.
- The user's login shell (`HostFactsStore.shellPath`) is POSIX-compatible enough for a sentinel/exec protocol (probe verifies for zsh/bash/fish).
- Shell exchange volume is modest (human-typed commands), so a sqlite ledger and full-tail fetch at restore are cheap.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows `tuglaws/devise-skeleton.md` v4: explicit `{#anchor}` headings, kebab-case anchors without phase numbers, stable two-digit labels (`[P01]` plan-local decisions, `[Q01]` open questions, `S01` specs, `T01` tables, `R01` risks, `M01` milestones), `**Depends on:**` lines citing `#step-N` anchors, and rich `**References:**` lines on every step. `[D##]` citations refer to the global `tuglaws/design-decisions.md`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Shell execution backend (DECIDED) {#q01-exec-backend}

**Question:** What process architecture backs the block-oriented shell session — (a) a tmux-backed session (bundled tmux, `send-keys` + output capture), (b) a long-lived `$SHELL` child driven by a sentinel protocol over a PTY or pipes, or (c) one-shot `$SHELL -c` per command with explicit cwd/env threading?

**Why it matters:** This decides relaunch survival (tmux sessions outlive tugcast; a child shell does not), exit-code/output-boundary capture (trivial with sentinels, awkward with raw tmux), and the amount of new supervision code in `feeds/shell.rs`.

**Options (if known):**
- (a) tmux-backed: free relaunch survival and instance isolation (`tmux_server_args()` precedent in `feeds/terminal.rs`); boundary capture needs a sentinel *inside* the tmux pane anyway.
- (b) sentinel-driven child: simplest correct boundaries (`printf '<sentinel> %s\n' $?` after each command; read until sentinel); dies with tugcast — restart semantics must be defined ([Q04]).
- (c) one-shot per command: trivially robust, but `cd`/env state requires shell-state serialization tricks; weakest fit for the persistent-session POR.

**Plan to resolve:** Phase 1 probe (#step-1) builds minimal spikes of (a) and (b) and records findings; (c) is the documented fallback.

**Resolution:** **DECIDED → (b) sentinel-driven persistent child in pipe mode** (folded into [P09]). The probe (`tugrust/crates/tugcast/probes/shell-exec/FINDINGS.md`) rejected (a) tmux — its fixed TTY grid truncated tall output (`seq 1 120` → 47 of 120 lines captured), pads with blank rows, re-wraps lines, and *renders* pagers/TUIs, all fighting the block model [P04]; tmux's one advantage (cross-restart survival) is redundant because the ledger ([P07]) makes the *record* durable regardless. Rejected (c) one-shot — no cwd/env persistence without state-serialization hacks. Option (b) gave byte-accurate boundaries, full untruncated output, cwd + env persistence (verified on zsh and bash), and pipe-mode hardening for free. **Sub-decision:** the exec shell is a **known POSIX shell** (the login shell if bash/zsh, else `/bin/zsh`), not blindly `HostFactsStore.shellPath` — the sentinel protocol is POSIX/bash/zsh syntax and fish (`$status`, different grouping) would need its own emitter; a block-exec shell need not *be* the login shell.

#### [Q02] Exchange protocol: output capture, boundaries, streaming (DECIDED) {#q02-exchange-protocol}

**Question:** What exactly does one "exchange" carry on the wire — combined stdout/stderr or separated? Streamed chunks or settled-whole? How are exit code, duration, and post-command cwd captured?

**Why it matters:** Fixes Spec S01 (the `SHELL_OUTPUT` frame family) and the `shell_exchange` Message shape (Spec S04); streaming vs settled decides whether `TerminalBlock`'s streaming mode (its `streamingStore`/`PropertyStore` path) is needed for live output.

**Options (if known):**
- Settled-whole exchanges (simplest; matches the `/btw` answer model) with a size cap.
- Chunk-streamed output frames between `exchange_started`/`exchange_complete` brackets (matches long-running commands like builds; `TerminalBlock` already supports streaming).

**Plan to resolve:** Phase 1 probe measures capture latency and chunking behavior under the chosen backend; long-running commands (`cargo build`) decide whether streaming is required for v1.

**Resolution:** **DECIDED → settled-whole for v1, combined stream; streaming frames reserved** (Spec S01, Spec S04). The probe measured arrival spread: bulk output arrives effectively all-at-once (`seq 1 100000` = 589 KB landed within 2 ms across 4 chunks; `seq 1 5000` within 0 ms), so streaming buys nothing for the common fast command. Only a *genuinely slow producer* trickles (a 20-line drip over 1.25 s showed 21 chunks), which is the `cargo build` case. v1 captures the whole exchange and emits `output` at `exchange_complete`; the Spec S01 sequence keeps the optional `exchange_output` chunk frames reserved so streaming is a cheap follow-on (`TerminalBlock` already streams). **Streams:** stdout and stderr are **combined into one ANSI-bearing string** (interleaved via `2>&1` at exec time, terminal-WYSIWYG), the sentinel riding the merged stream — Spec S04 `output` is that single string.

#### [Q03] Non-interactive hardening (DECIDED) {#q03-hardening}

**Question:** Which environment and detection measures keep the block shell non-interactive — `PAGER=cat`, `GIT_PAGER=cat`, `TERM=dumb`, `GIT_TERMINAL_PROMPT=0`, closed/null stdin? How is a command that still blocks awaiting input detected and surfaced (timeout + kill affordance)?

**Why it matters:** A single hung `git log` (pager) or `ssh` (password prompt) with no kill affordance makes the shell route unusable; the env recipe is also part of the honest "supported capabilities" story.

**Plan to resolve:** Phase 1 probe runs a gauntlet (pager commands, stdin-wanting commands, TUI launches) under the candidate env and records what leaks through; the kill affordance design lands in Spec S01's `exchange` lifecycle.

**Resolution:** **DECIDED → pipe mode + hardened env + per-command `</dev/null` + timeout/signal-kill** (baked into the service, Spec S01). The recipe, all probe-verified: (1) **hardened env** on every exec — `PAGER=cat GIT_PAGER=cat TERM=dumb GIT_TERMINAL_PROMPT=0`; (2) **no controlling TTY** (pipe mode) so `isatty()` is false — pagers/color self-disable, and `/dev/tty` grabs (ssh/sudo password prompts) fail fast with exit 1 instead of hanging; (3) **per-command `{ <command> ; } </dev/null`** stdin isolation — the probe found a real desync flaw where a stdin-reading command (`cat`) swallowed the sentinel-emitter line and corrupted the protocol; the redirect fixed it while keeping the shell's own channel intact; (4) **timeout + signal-kill** — a genuine long-runner (`sleep 30`) wedges the foreground so the *next* stdin line also blocks, proving cancellation must **signal the running command's pgid** (SIGTERM→SIGKILL, the `kill` verb in Spec S01), never write another line. TUI gauntlet: vim/nano warn-and-exit, `less` dumps like `cat`, `top -l 1` snapshots — **none hang**.

#### [Q04] Relaunch / restart semantics (DECIDED) {#q04-relaunch-semantics}

**Question:** When tugcast restarts (or the app relaunches), does the shell session survive (tmux) or restart fresh in the project dir (child shell)? Either way, how is the boundary surfaced to the user (a system-note-style divider? the cwd chip resetting)?

**Why it matters:** The transcript's shell rows persist via the ledger regardless, but a user mid-`cd` deserves to know their shell state reset; silently losing cwd/env is a trust break.

**Plan to resolve:** Follows [Q01]'s backend choice; probe records tmux-session survival across a tugcast restart.

**Resolution:** **DECIDED → no cross-restart survival; the shell restarts fresh in the project dir; the record persists via the ledger** ([P07], [P09]). The chosen child-shell backend (b) is a child of tugcast and dies when tugcast restarts — there is no in-process state to carry across (the rejected tmux backend would have survived, but its block-model costs outweigh that, and the *record* is already durable via the ledger). On (re)spawn the session restarts in the card's project dir with cwd/env reset to defaults; the service emits `shell_state { live: true, cwd: <projectDir> }` so the cwd chip resets truthfully, plus an optional subdued system-note divider marking "shell restarted" so a user mid-`cd` understands the jump. Consistent with the doctrine ([P11]): the record is durable, the live shell is ephemeral.

#### [Q05] `btw` route keybinding (OPEN) {#q05-btw-keybinding}

**Question:** Is `⇧⌘B` free for `SELECT_ROUTE "?"` (alongside `⇧⌘C` code / `⇧⌘S` shell in `tugdeck/src/components/tugways/keybinding-map.ts`), or does it collide with a WebKit/system default worth preventing?

**Why it matters:** Cheap, but a silent collision (e.g. a browser "bold" default leaking into non-editor focus) would make the shortcut flaky.

**Plan to resolve:** Check `keybinding-map.ts` and test in the debug app during #step-3; `preventDefaultOnMatch: true` mirrors the existing route shortcuts.

**Resolution:** OPEN — resolved in #step-3 (no plan update needed; record the choice in the keybinding-map comment).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Shell-route submits currently reach Claude; behavior change surprises a habituated user | low | low | Phase 2 interim notice (Spec S03 note); Phase 3 makes the route real | User feedback after Phase 2 |
| Restore interleave misorders shell rows vs Claude turns | high | med | Single merge point ([P07]), timestamp discipline in the ledger, app-test pinning row order across reload (R02) | Any reordering seen in `at`-test or manual reload |
| Z4B manifest swap causes layout jump / focus loss | med | med | Width stabilization within route (existing `TugStableOverlay` pattern in `dev-route-indicator-badge.tsx`); mount-identity rules [L26]; geometry app-test (R04) | Visual jump on route flip |
| Hung interactive command with no kill affordance | high | low | RESOLVED by probe: pipe-mode + hardened env + `</dev/null` means no gauntlet case hangs; pgid signal-kill + per-exchange timeout for the residual (Q03) | Any hang reproduced against the shipped `feeds/shell.rs` |
| A non-POSIX login shell (fish) breaks the sentinel protocol | med | low | Exec shell is a service-chosen POSIX shell (bash/zsh, else `/bin/zsh`), never blindly `$SHELL` ([P09], Q01 sub-decision) | A user reports shell exec failing under a fish/nushell login |

**Risk R01: Shell route behavior flip** {#r01-shell-route-flip}

- **Risk:** Users who (mistakenly or deliberately) used the `$` route to talk to Claude lose that path when Phase 2 gates it.
- **Mitigation:** The Phase 2 interim state shows a clear client-side notice (the [D14] unsupported-command notice pattern); the code route is one click away; Phase 3 delivers the real behavior.
- **Residual risk:** None meaningful — the current behavior is an accident of the unconditional `send()`.

**Risk R02: Interleave consistency across reload/resume** {#r02-interleave-consistency}

- **Risk:** Shell rows appear at different positions live vs after Developer ▸ Reload vs after app relaunch, breaking the "one record" promise.
- **Mitigation:** One interleave algorithm in one place (the restore path in `CodeSessionStore`), ledger rows carry wall-clock + monotonic sequence, app-test asserts identical row order before/after reload.
- **Residual risk:** Clock skew between tugcode JSONL timestamps and tugcast ledger stamps could flip adjacent rows recorded within the same second; the monotonic sequence within each source bounds the damage to cross-source adjacency.

**Risk R04: Z4B chrome swap geometry** {#r04-z4b-geometry}

- **Risk:** Per-route show/hide reflows the toolbar mid-interaction.
- **Mitigation:** Swaps happen only on explicit route gestures (allowed by design — Z4B is the centred-floating slot whose occupancy is not contract, [D97]); within a route every chip keeps width-stabilized faces; app-test asserts Z5 submit button and Z4A group positions are unmoved by route flips.
- **Residual risk:** The centred cluster re-centers with different content widths across routes — accepted and intended.

---

### Design Decisions {#design-decisions}

#### [P01] Routes are recipients; `btw` is the third route (DECIDED) {#p01-routes-are-recipients}

**Decision:** The Z4A choice group carries three routes — `❯` Code (Claude on the record), `$` Shell (the machine), `?` btw (Claude off the record) — with route value `"?"`, label `btw` (lowercase, matching the `/btw` branding), icon `MessageSquareDashed` (the side-question overlay's icon).

**Rationale:**
- Unifies `/btw` into the card's conceptual model without giving it transcript ink; the Slack-channel metaphor from the originating discussion is literally "who receives this text".
- The choice-group's geometry accommodates three near-equal-width labels after minor tuning.

**Implications:**
- `ROUTE_ITEMS`, `ROUTE_PREFIX_ALIAS` (add `"?" → "?"`), `RETURN_ACTION_BY_ROUTE` (`"?": "submit"` — side questions are single-line asks) in `tugdeck/src/components/tugways/tug-prompt-entry.tsx`.
- A `SELECT_ROUTE` keybinding (`⇧⌘B`, [Q05]) in `keybinding-map.ts`.
- `/btw` remains a slash command too — the route and the command are two entries to the same surface ([D108] unchanged).

#### [P02] Per-route submit dispatch in `TugPromptEntry` (DECIDED) {#p02-per-route-submit}

**Decision:** `performSubmit`'s unconditional `codeSessionStore.send()` is replaced by a per-route dispatch: `❯` → `codeSessionStore.send(wireText, wireAtoms)` (unchanged); `?` → dispatch `RUN_SLASH_COMMAND` with `/btw <text>` through the existing local-command responder path; `$` → interim client-side notice (Phase 2), then the shell send (Phase 3, [P12]).

**Rationale:**
- The `?` route reuses the entire shipped `/btw` machinery — `matchLocalSlashCommand` → `manager.sendToTarget(targetId, RUN_SLASH_COMMAND)` → the dev card's `slashCommandSurfaces.btw` handler → `SideQuestionStore.ask` — including mid-turn dispatch ([D108] [P04]) and history recording, with zero new plumbing.
- The current Shell behavior (silently sending to Claude) is a defect, not a feature; an honest notice beats a lie.

**Implications:**
- Route dispatch lives beside the existing local-command branch in `performSubmit` (`tug-prompt-entry.tsx`); the empty-input guard, prefix strip (`computeSubmitText` + `ROUTE_PREFIX_ALIAS`), and history push apply to all routes.
- History entries already carry `route`; the `RouteHistoryProvider` per-route timeline works unchanged.

#### [P03] Per-route Z4B chrome manifest (DECIDED) {#p03-z4b-manifest}

**Decision:** A declarative manifest (Table T01) maps route → visible Z4B chips with **show/hide** semantics, replacing `DevRouteShellGate`'s disable-scatter (`dev-card.tsx`, the `disabled={isShell}` props on Session/Mode/Model/Effort chips).

**Rationale:**
- Route changes are explicit user gestures; swapping the centred-floating cluster on them is Z4B working as designed ([D97]: occupancy is a layout decision, not contract). Within a route, chips stay width-stabilized (the `feedback_fixed_width_buttons` doctrine); across routes, re-centring is intended.
- Disabled-but-visible Claude chips on the Shell route communicate the wrong thing once shell is real.

**Implications:**
- A `DevRouteChromeManifest` mapping renders the cluster; `DevRouteIndicatorBadge` gains a third branch (Table T01); the focus-cycle orders (`DEV_CYCLE_ORDER_*`) skip hidden chips naturally (unregistered stops drop out of the walk, per the existing disabled-chip behavior).
- `DevRouteIndicatorBadge` keeps its single-mount identity across flips ([L26] — the badge's documented mount-identity contract extends to three branches).

#### [P04] Block-oriented shell; no TTY emulator (DECIDED — POR) {#p04-block-shell}

**Decision:** The shell surface is block-oriented command/output exchanges (Warp-style) rendered as transcript rows. No terminal emulation, no interactive TUIs, no cursor addressing.

**Rationale:**
- The transcript is the card's one scrolling surface; a TTY grid inside it is a different product.
- Capabilities are built up deliberately (exec → cwd state → env → chains), never stripped down from a full terminal.

**Implications:**
- `TerminalBlock` (ANSI-aware, static + streaming modes, flat/virtualized rendering) is the rendering substrate — no xterm.js, no new emulator dependency.
- [Q03] hardening keeps commands non-interactive by construction.

#### [P05] Raw always renders; richness accretes via a command-block registry (DECIDED — POR) {#p05-command-registry}

**Decision:** Every command executes and renders via the generic terminal block. A `COMMAND_BLOCK_REGISTRY` on the [D101] grammar (bespoke registrations / default block / governance test) lets curated commands gain bespoke rendering over time. The registry ships as a skeleton; bespoke renderers are follow-ons.

**Rationale:**
- An execution allowlist would kill the shell as a terminal replacement on day one; enhancement-not-permission is the [D101] lesson applied to commands.

**Implications:**
- `resolveCommandBlock(command) → renderer` beside the tool-block dispatch; default = `TerminalBlock`-based generic exchange block; governance test pins classification rules.

#### [P06] Shell exchanges are transcript rows with `shell` turn origin (DECIDED) {#p06-shell-transcript-rows}

**Decision:** Each settled exchange becomes a transcript turn with `TurnOrigin` `"shell"` (activating the reserved `#s` addressing) carrying one `shell_exchange` Message (Spec S04), rendered by a shell exchange block that composes `TerminalBlock`, styled as visually distinct **non-context ink**.

**Rationale:**
- Option B from the originating discussion: one scrolling record of the working session. The `#s` reservation in `types.ts` documents this as the original intent.
- Distinct styling (shell identity gutter icon, subdued frame) keeps "what does Claude know" legible — shell rows are visibly not context.

**Implications:**
- `TurnOrigin` widens to `"user" | "assistant" | "shell"`; `turn-metric.md`'s addressing doc and any exhaustive-match sites update.
- `DevTranscriptDataSource` (`tugdeck/src/lib/dev-transcript-data-source.ts`) maps shell turns to a shell row kind; Z1A/Z1B per-turn chrome renders shell-appropriate trailing content (exit code, duration — not model/tokens).
- The global docs step records the doctrine change: the transcript is the session's record of what happened, not a strict mirror of Claude's context ([P11]).

#### [P07] Persistence: tugcast ledger + CONTROL tail-fetch + deck-side interleave (DECIDED) {#p07-ledger-interleave}

**Decision:** tugcast persists every settled exchange in a sqlite ledger table keyed by `tug_session_id` (Spec S02). Live exchanges reach the deck as `SHELL_OUTPUT` frames. At restore (Developer ▸ Reload, app relaunch), the deck fetches the bound session's exchange tail via a `list_shell_exchanges` / `list_shell_exchanges_ok` CONTROL pair (the `list_pulse_lines` shape) and `CodeSessionStore` interleaves ledger rows with replayed Claude turns by timestamp.

**Rationale:**
- The Claude JSONL replay lives in tugcode (`tugcode/src/replay.ts`) and must not learn about shell content; shell persistence is tugcast's job (it owns the shell service and the sqlite precedents).
- One deterministic merge point in the deck's restore path keeps live and restored transcripts identical (R02).

**Implications:**
- Exchanges stamp `tug_session_id` at settle time — the transcript identity is the Claude session, so `/clear` (new session) naturally starts a fresh shell record while the old session's record stays intact for resume.
- Ledger rows carry wall-clock ms + per-session monotonic sequence; the interleave sorts committed Claude turns and shell rows by timestamp with source-stable tiebreak.
- HMR never re-runs the interleave (HMR preserves store state — the baked-in invariant); only true restore paths do.

#### [P08] Claude visibility: never implicit; on-demand share gesture (DECIDED — POR) {#p08-share-gesture}

**Decision:** Claude never sees shell exchanges implicitly. A per-exchange **Share** affordance composes the command + output (fenced, with exit code) into the prompt entry on the code route for the user to edit and send. Always-in-context is a documented non-goal.

**Rationale:**
- "Claude sees it because you said it" is the honest semantics; no ledger↔JSONL correlation machinery needed.

**Implications:**
- The share affordance lives in the shell exchange block's chrome (beside Copy); it sets the route to `❯` and inserts text via the prompt-entry editor API.

#### [P09] Shell session: one per card, persistent POSIX child in pipe mode, owned by tugcast (DECIDED) {#p09-shell-session}

**Decision:** Each Dev card gets at most one shell session, lazily started on first `$`-route submit, spawn cwd = the card's bound project dir, owned and supervised by a new `feeds/shell.rs` service in tugcast. The process is a **long-lived POSIX-shell child** (the login shell if it is bash/zsh, else `/bin/zsh`) spawned in **pipe mode (no PTY / no controlling TTY)**, driven by a **sentinel protocol**: after each command the service writes a sentinel emitter (`printf '\n<sentinel>\t%d\t%s\n' "$?" "$PWD"`) and reads the merged stdout+stderr stream until the sentinel, yielding exact output boundaries, exit code, and post-command cwd in one read (Q01 → option b, probe-confirmed).

**Rationale:**
- Per-card matches the card's one-project binding and the cwd chip's meaning; lazy start costs nothing for cards that never use the shell.
- The probe (`probes/shell-exec/FINDINGS.md`) proved pipe-mode child gives byte-accurate boundaries, full untruncated output, and cwd/env persistence — where tmux truncates tall output and one-shot loses state.

**Implications:**
- Session lifecycle (spawn, health, teardown on card close, [Q04] restart-fresh-in-project-dir semantics) lives in `feeds/shell.rs`; the deck holds no process state.
- The service tracks each running command's **pgid** so the `kill` verb can signal it (SIGTERM→SIGKILL) — a wedged foreground command cannot be cancelled by writing another line (Q03).
- Hardening is intrinsic, not optional: hardened env (`PAGER`/`GIT_PAGER`=cat, `TERM=dumb`, `GIT_TERMINAL_PROMPT=0`), per-command `{ …; } </dev/null` stdin isolation, no TTY, per-exchange timeout (Q03).
- The exec shell is chosen by the service (POSIX guarantee), NOT taken blindly from `HostFactsStore.shellPath` — a fish login shell still gets a bash/zsh exec child.
- No instance-scoped tmux server is needed (tmux rejected); process-group isolation is the child's own pgid.

#### [P10] cwd chip on the shell route (DECIDED) {#p10-cwd-chip}

**Decision:** The shell route's Z4B cluster includes a `Cwd` chip (label-top, matching the Project chip's grammar) showing the shell session's current working directory, falling back to the project dir before the session first spawns.

**Rationale:**
- Project answers "where is this card anchored"; Cwd answers "where is the shell standing" — the pairing makes stateful cwd legible.

**Implications:**
- The chip reads `ShellSessionStore` ([P12]) via `useSyncExternalStore` [L02]; post-command cwd arrives on each settled exchange (Spec S01). The chip component ships in Phase 2 wired to the fallback; Phase 3 binds it live.

#### [P11] Transcript doctrine: the session's record, not a context mirror (DECIDED) {#p11-transcript-doctrine}

**Decision:** The Dev transcript's contract changes from "mirror of Claude's context" to "the session's record of what happened". Non-context rows (shell exchanges) must be visually distinct; context-affecting and non-context ink must never be confusable. `/btw` remains excluded entirely ([D108] unchanged) — asides are meta-conversation, not session work.

**Rationale:**
- Threading shell work into one record is the whole point of Option B; the doctrine must be explicit so future features don't blur the line by accident.

**Implications:**
- A new global design-decision entry in `tuglaws/design-decisions.md` (written in the Phase 3 docs step), cross-referencing [D97], [D101], [D108].

#### [P12] `ShellSessionStore` is the single feed consumer; exchanges enter the transcript through `CodeSessionStore` at start AND settle (DECIDED) {#p12-shell-store}

**Decision:** A per-card `ShellSessionStore` (the `SideQuestionStore` triple pattern in `card-services-store.ts`: filter → feed-store → store) is the sole consumer of `SHELL_OUTPUT` frames. It owns shell *session* state (liveness, cwd) but **does not own the in-flight exchange's transcript presence**. Instead it forwards the exchange lifecycle into `CodeSessionStore` through one typed public ingest, `ingestShellExchange(event)`, called twice per exchange: on `exchange_started` (mint an **uncommitted** shell turn — the live-edge row) and on `exchange_complete` (settle that same turn in place with output + exit code + `cwdAfter`). A `kill` settles the turn with `exitCode: null`.

**Rationale:**
- Keeps `CodeSessionStore`'s feed filter untouched (`CODE_OUTPUT`/`SESSION_STATE` only) and its reducer pure; one consumer chain, no dual-ingest races.
- **Single-snapshot data source.** `DevTranscriptDataSource` projects rows from *one* `CodeSessionStore` snapshot today (user / assistant / ghost rows, ghosts from `queuedSends` in that same snapshot). Rendering the in-flight exchange out of a *second* store (`ShellSessionStore`) would force the data source to compose two snapshots — real, avoidable work. Minting the uncommitted turn through `CodeSessionStore` keeps the data source single-snapshot; the shell live edge reuses the exact uncommitted-turn machinery the Claude live edge already uses.
- Mirrors the shipped side-question triple for the *feed wiring*, so that half is proven and tested.

**Implications:**
- `CardServices` gains `shellSessionStore` (+ filter/feed-store internals and `_dispose` teardown) in `tugdeck/src/lib/card-services-store.ts`; `DevCardServices` threads it to the card (`use-dev-card-services.ts`, `dev-card.tsx`).
- The prompt entry's `$`-route dispatch ([P02]) calls `shellSessionStore.exec(command)`; the store emits `SHELL_INPUT`, folds `SHELL_OUTPUT` for session state (cwd/liveness), and mirrors the exchange lifecycle into `codeSessionStore.ingestShellExchange`.
- `ingestShellExchange` dispatches a reducer event with a `phase` (`"started" | "complete"`) keyed by `exchange_id`; the reducer mints-then-settles the shell turn. Restore ([P07]) reuses the **settle** path only (ledgered exchanges are always already-complete), inserting positionally instead of appending.
- `ShellExchangeMessage.exitCode` is `null` while in flight and after a kill; `output` accretes only at settle (or per-chunk if [Q02] lands on streaming).

#### [P13] Route-aware submit button; serial exec on the `$` route (DECIDED) {#p13-route-aware-submit}

**Decision:** The Z5 submit button's mode becomes route-aware. Today `resolveSubmitButtonView` (`tug-prompt-entry-submit-button.ts`) is a pure projection from `DevSubmitButtonMode`, which is derived **entirely from the Claude session lifecycle** (`code-session-store/lifecycle-state`). On the `$` route the button's mode is instead composed from `ShellSessionStore` in-flight state: an exchange in flight → `stop` pose (→ `kill()`); otherwise `submit`. The Claude-derived mode drives Z5 only on the `❯` and `?` routes. **Serial exec:** while a `$` exchange is in flight, a second `$` submit is refused at the button (the `stop` pose is not `submit`) — no queue. `?`-route side questions are unaffected (they dispatch locally, mid-turn, bypassing Z5's send gate, per [D108]).

**Rationale:**
- Z5 is one DOM node across all modes ([L26]); a route-aware *mode selector* (not a second button) preserves that — only `data-mode`/label/icon change, never the element.
- The shell exchange is the shell route's "turn in flight"; mapping it onto the existing `stop` pose reuses the shipped visual + the kill affordance with no new chrome.
- Serial exec (no queue) matches a human-typed block shell — one command at a time — and sidesteps a queue/cancel UI this plan doesn't want; a busy shell simply shows `stop` until the command finishes or is killed.

**Implications:**
- A route-aware wrapper around `resolveSubmitButtonView`'s input in `tug-prompt-entry.tsx`: pick the `DevSubmitButtonMode` from either the Claude lifecycle (`❯`/`?`) or a `ShellSessionStore`-derived mode (`$`). The pure projection function itself is unchanged.
- The `+` mid-turn-queue button (Claude-route only) stays code-route behavior; it does not appear for shell in-flight.
- Empty-draft disabling (`data-empty`) still applies on `$` when no exchange is running.

---

### Deep Dives {#deep-dives}

#### Current-state inventory (verified 2026-07-09) {#current-state-inventory}

- **Shell route today:** `ROUTE_ITEMS` in `tugdeck/src/components/tugways/tug-prompt-entry.tsx` defines `❯ Code` / `$ Shell`; `performSubmit` sends every submission via `codeSessionStore.send(wireText, wireAtoms)` regardless of route. Route-sensitivity today: `RETURN_ACTION_BY_ROUTE` (Return semantics), prefix strip via `ROUTE_PREFIX_ALIAS` + `computeSubmitText`, per-route history timelines, and `DevRouteShellGate` in `dev-card.tsx` (renders children with `isShell` to set `disabled` on the Session/Mode/Model/Effort chips).
- **Z4B cluster** (in `dev-card.tsx`'s `indicatorsContent`): `DevRouteIndicatorBadge` (`chrome/dev-route-indicator-badge.tsx` — two branches: Code = Claude Code version + drift, Shell = `$SHELL` path from `HostFactsStore.shellPath`; width-stabilized via `TugStableOverlay`; single-mount contract), then gate-wrapped `DevSessionIdBadge`, `effectivePromptStatusContent` (the Project chip, built inline in `dev-card.tsx` around `formatProjectChipText`), `PermissionModeChip`, `ModelChip`, `EffortChip`, then `effectiveFooterContent`.
- **Keybindings:** `keybinding-map.ts` — `⇧⌘C` → `SELECT_ROUTE "❯"`, `⇧⌘S` → `SELECT_ROUTE "$"`, both `preventDefaultOnMatch: true`.
- **Route state:** `RouteLifecycle` (`tugdeck/src/lib/route-lifecycle.ts`) — per-prompt-entry store + synchronous will/did delegate; `useRoute()` for renderers; every trigger funnels through `setRoute`.
- **Transcript row model:** `code-session-store/types.ts` — `Message` union (`user_message | assistant_text | assistant_thinking | system_note | tool_use`), `TurnOrigin = "user" | "assistant"` with the doc comment explicitly reserving `#s` shell. Rows project via `DevTranscriptDataSource` (user / assistant / ghost row kinds).
- **Restore:** `dev-session-restore.ts` re-asserts bindings and re-issues `spawn_session(mode=resume)`; tugcode's `replay.ts` translates the Claude JSONL into synthetic frames bracketed by `replay_started`/`replay_complete`; the same reducer folds them (`KNOWN_CODE_OUTPUT_TYPES` gate in `code-session-store.ts`).
- **Wire reservations:** `SHELL_OUTPUT: 0x60`, `SHELL_INPUT: 0x61` in `tugdeck/src/protocol.ts` and `tugrust/crates/tugcast-core/src/protocol.rs` — named, tested, unconsumed.
- **tugcast assets:** `feeds/terminal.rs` (legacy PTY-tmux bridge — an existing feed for reference on stdio/broadcast wiring, but the shell service is a new `feeds/shell.rs` using pipe-mode `tokio::process`, NOT tmux — see [Q01]), `session_ledger.rs` (sqlite, two tables, trigger-based cascade — the ledger pattern), `feeds/pulse.rs` (`pulse_lines` capped ledger + `list_pulse_lines` CONTROL tail-fetch — the restore-fetch pattern).
- **Rendering assets:** `body-kinds/terminal-block.tsx` (ANSI parsing, static/streaming modes, sticky header with Copy, flat/virtualized body); `BashToolBlock` shows the compose-TerminalBlock pattern for command/output data.
- **/btw assets:** `SideQuestionStore` (`lib/side-question-store.ts`), overlay (`cards/side-question-overlay.tsx`), local dispatch via `slashCommandSurfaces.btw` in `dev-card.tsx`, `at0211` app-test, [D108].

#### Restore interleave flow {#restore-interleave-flow}

1. Restore path runs as today: `spawn_session(mode=resume)` → tugcode replay emits `replay_started` → committed-turn frames → `replay_complete`; the reducer folds Claude turns into `state.transcript`.
2. In parallel (or on `replay_complete`), the deck issues `list_shell_exchanges { tug_session_id }` on CONTROL; tugcast answers `list_shell_exchanges_ok { exchanges: [...] }` from the ledger (Spec S02).
3. `CodeSessionStore` runs the interleave once both are settled: merge-sort committed turns (by their first-message timestamp) with shell exchanges (by `settled_at`), stable within each source by sequence. Ledgered exchanges are always already-complete, so each mints-and-settles a `shell`-origin turn in one step through `ingestShellExchange` (the `complete`-with-no-prior-`started` path, [P12]) — the only difference from the live path is batch + positional insert instead of live-edge append.
4. Live exchanges after restore append through the normal `ShellSessionStore → ingestShellExchange` path.
5. HMR: stores survive, nothing re-runs. Developer ▸ Reload / app relaunch: full path re-runs from 1.

#### Interim Phase 2 shell-route behavior {#interim-shell-notice}

Between Phase 2 and Phase 3 the `$` route's submit dispatch shows the existing client-side notice surface (`SHOW_SLASH_COMMAND_NOTICE` pattern in `performSubmit`, adapted with a shell-specific reason/copy: "Shell execution isn't wired up yet") instead of silently sending to Claude. The draft is preserved (no `editor.clear()`), so nothing is lost. This is deliberately a small, throwaway branch — Phase 3's Step flips it to `shellSessionStore.exec`.

---

### Specification {#specification}

**Spec S01: SHELL wire frames (FINALIZED — [Q01]/[Q02]/[Q03]/[Q04] resolved)** {#s01-shell-wire}

All shell frames are JSON payloads on the reserved feed IDs, session-scoped like other per-card feeds:

- `SHELL_INPUT` (deck → tugcast): `{ type: "exec", card_id, tug_session_id, exchange_id, command }` and `{ type: "kill", card_id, exchange_id }` (kill signals the running command's pgid, SIGTERM→SIGKILL — Q03).
- `SHELL_OUTPUT` (tugcast → deck):
  - `{ type: "exchange_started", exchange_id, command, cwd, started_at }`
  - `{ type: "exchange_complete", exchange_id, exit_code, cwd_after, duration_ms, output }` — **`output` is present and carries the whole combined (stdout+stderr, ANSI) stream** (settled-whole v1, Q02); `exit_code` is `null` for a killed/timed-out exchange.
  - `{ type: "shell_state", live, cwd }` — liveness + cwd for the chip and the restart-reset notice (Q04).
  - **Reserved (not emitted in v1):** `{ type: "exchange_output", exchange_id, chunk }` — the streaming-chunk frame kept in the grammar so the slow-producer streaming follow-on drops in without a wire change (Q02).

**Spec S02: Shell exchange ledger + CONTROL pair** {#s02-shell-ledger}

A sqlite table in tugcast (beside `session_ledger.rs`'s db or its own file, implementer's choice following that module's conventions): `shell_exchanges(id INTEGER PK, tug_session_id TEXT, seq INTEGER, command TEXT, output TEXT, exit_code INTEGER, cwd TEXT, cwd_after TEXT, started_at_ms INTEGER, settled_at_ms INTEGER)`, indexed by `tug_session_id`. Capped per session (500 exchanges; oldest evicted) — cap logged, not silent. CONTROL pair `list_shell_exchanges { tug_session_id }` → `list_shell_exchanges_ok { exchanges }` follows the `list_pulse_lines` request/response shape in `feeds/pulse.rs`. Only settled exchanges are ledgered; an exchange in flight at crash is lost (matches the "record of what happened" doctrine — it never settled).

**Spec S03: Per-route Z4B chrome manifest** {#s03-chrome-manifest}

**Table T01: Route → Z4B chips** {#t01-route-chrome}

| Route | Identity badge (`DevRouteIndicatorBadge` branch) | Chips shown |
|-------|--------------------------------------------------|-------------|
| `❯` code | `CLAUDE CODE` / version (drift-aware) — unchanged | Session · Project · Mode · Model · Effort |
| `$` shell | `SHELL` / `$SHELL` path — unchanged | Project · Cwd |
| `?` btw | `CLAUDE CODE` / version (the btw recipient is the bound session) | Session · Project |

Semantics: chips absent from a route's row **unmount** (show/hide, not disable). The identity badge itself never unmounts ([L26] single-mount contract; it swaps branch content only). Focus-cycle stops for hidden chips drop out of the Tab walk (existing unregistered-stop behavior). `DevRouteShellGate` is deleted.

**Spec S04: `shell_exchange` Message + shell turn** {#s04-shell-message}

New `Message` kind in `code-session-store/types.ts`:

```ts
interface ShellExchangeMessage {
  kind: "shell_exchange";
  id: string;               // exchange_id
  command: string;
  output: string;           // ANSI-bearing combined stdout+stderr stream (settled-whole v1, Q02)
  exitCode: number | null;  // null = killed/aborted/timed-out
  cwd: string;              // cwd at exec
  cwdAfter: string | null;
  startedAtMs: number;
  settledAtMs: number;
}
```

A shell turn is a `TurnEntry` with `origin: "shell"` containing exactly one `shell_exchange` message; `TurnCost` zeros; Z1A trailing renders exit code + duration instead of model/timestamp-token chrome. `TurnOrigin` widens to `"user" | "assistant" | "shell"` — every exhaustive `switch`/match over `TurnOrigin` updates (the compiler enumerates the sites).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Active route | existing `RouteLifecycle` store | store + `useSyncExternalStore` (`useRoute`) | [L02] |
| Z4B chrome per route | pure render derivation from `useRoute()` + Table T01 | render-time mapping, no new state | [L02], [L26] |
| Shell session liveness / cwd | `ShellSessionStore` (per-card, card-services triple) | store + `useSyncExternalStore` | [L02] |
| Shell exchange transcript presence (in-flight + settled) | `CodeSessionStore.state.transcript` (shell-origin turns) | reducer event via `ingestShellExchange` (mint-on-start, settle-on-complete) | [L02] |
| Z5 submit-button mode per route | route-conditional selection of `DevSubmitButtonMode` (Claude lifecycle on `❯`/`?`; `ShellSessionStore`-derived on `$`) feeding the pure `resolveSubmitButtonView` | store reads + render-time selection; one DOM node, `data-mode`-keyed | [L02], [L26], [L06] |
| Exchange output rendering | `TerminalBlock` imperative body | CSS + DOM (body-kind contract) | [L06] |
| Route keybinding registration | existing keybinding map (static) | — | [L03] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/probes/shell-exec/` (scripts + `FINDINGS.md`) | Phase 1 probe artifacts |
| `tugrust/crates/tugcast/src/feeds/shell.rs` | Shell execution service: session lifecycle, exec, capture, SHELL frames |
| `tugrust/crates/tugcast/src/shell_ledger.rs` | sqlite exchange ledger + CONTROL pair handlers (Spec S02) |
| `tugdeck/src/lib/shell-session-store.ts` | Per-card shell store ([P12]) |
| `tugdeck/src/components/tugways/chrome/dev-route-chrome-manifest.tsx` | Table T01 as code: route → chip cluster renderer |
| `tugdeck/src/components/tugways/chrome/dev-cwd-chip.tsx` (+ css if needed) | Cwd chip ([P10]) |
| `tugdeck/src/components/tugways/cards/shell-exchange-block.tsx` (+ css) | Shell turn renderer composing `TerminalBlock` ([P06]) |
| `tugdeck/src/components/tugways/cards/dev-command-block-registry.ts` | `COMMAND_BLOCK_REGISTRY` skeleton ([P05]) |
| `tests/app-test/at02xx-route-chrome.test.ts` | Phase 2 route/chrome app-test |
| `tests/app-test/at02xx-shell-route.test.ts` | Phase 3 shell e2e + restore-interleave app-test |

(`at02xx` numbers assigned from `tuglaws/app-test-inventory.md`'s next free slots at implementation time.)

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ROUTE_ITEMS` / `ROUTE_PREFIX_ALIAS` / `RETURN_ACTION_BY_ROUTE` | const | `tugways/tug-prompt-entry.tsx` | add `?` route ([P01]) |
| `performSubmit` route dispatch | fn edit | `tugways/tug-prompt-entry.tsx` | [P02] |
| route-aware submit-button mode selector | fn edit | `tugways/tug-prompt-entry.tsx` | [P13] — wraps `resolveSubmitButtonView` input; pure projection unchanged |
| `SELECT_ROUTE "?"` binding | entry | `tugways/keybinding-map.ts` | [Q05] |
| `DevRouteShellGate` | **delete** | `cards/dev-card.tsx` | replaced by manifest ([P03]) |
| `DevRouteIndicatorBadge` | edit | `chrome/dev-route-indicator-badge.tsx` | third branch (T01) |
| `TurnOrigin` | type widen | `lib/code-session-store/types.ts` | `"shell"` ([P06]) |
| `ShellExchangeMessage` | interface | `lib/code-session-store/types.ts` | Spec S04 |
| `ingestShellExchange` | method | `lib/code-session-store.ts` | [P12] — `phase: "started" \| "complete"`, keyed by `exchange_id` |
| restore interleave | fn | `lib/code-session-store.ts` | [P07], #restore-interleave-flow |
| `shellSessionStore` triple | fields | `lib/card-services-store.ts` | side-question precedent |
| `DevTranscriptDataSource` | edit | `lib/dev-transcript-data-source.ts` | shell row kind |
| `FeedId::SHELL_*` consumers | new | tugcast `router.rs` / `feeds/mod.rs` | wire the reserved IDs |
| `encodeShellInput` / shell payload codecs | fns | `tugdeck/src/protocol.ts` | Spec S01 |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md`: new global entry — transcript doctrine ([P11]) + shell-in-transcript + `btw` route; supersede-note on [D97]'s Z4A occupant row (three routes) and on [D108] (surface unchanged; `?` route added as an entry point).
- [ ] `tuglaws/turn-metric.md` (or the addressing doc that reserves `#s`): mark `#s` active.
- [ ] `tuglaws/route-lifecycle.md`: three-route reality, per-route submit dispatch.
- [ ] `tuglaws/app-test-inventory.md`: register the new `at`-tests.
- [ ] Auto-memory: shell service + ledger reference entry (per-project memory conventions).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun test)** | Route dispatch table, manifest mapping, reducer shell-turn fold, interleave ordering, ledger payload codecs | Phases 2–3 deck logic |
| **Rust (cargo nextest)** | `feeds/shell.rs` exec/capture lifecycle, ledger CRUD + cap, CONTROL pair | Phase 3 tugcast |
| **App-test (`just app-test`)** | Real-app route cycling + chrome geometry; shell exchange e2e; row order across Developer ▸ Reload | Phase 2 and 3 exit gates |
| **Probe (manual, committed findings)** | Backend selection gauntlet | Phase 1 |

#### What stays out of tests {#test-non-goals}

- jsdom render tests / mock-store assertions — banned project-wide; app-tests drive the real app instead.
- Bespoke command renderers — none ship in this plan; the registry governance test covers classification only.
- Shell backend internals below the service contract (raw `tokio::process` piping, signal delivery) — the probe pins the behavior once; the service's Rust tests exercise the exec/kill/cwd contract, not the OS process primitives.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Commits go through `tugutil dash commit` on the plan's dash worktree, per repo policy.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Shell execution probe | done | 6fc1ac45e |
| #step-2 | Resolve Q01–Q04; finalize Specs S01/S02/S04 | done | 68c34d1d4 |
| #step-3 | `btw` third route in the prompt entry | done | 38f635c3a |
| #step-4 | Per-route submit dispatch | done | 01350399c |
| #step-5 | Per-route Z4B chrome manifest | done | 56be8881b |
| #step-6 | Route chrome app-test + geometry | done | bab6ac4a9 |
| #step-7 | Phase 2 integration checkpoint + docs | done | 09e8d4d2b |
| #step-8 | tugcast shell service (`feeds/shell.rs`) | done | 2eda4688f |
| #step-9 | Shell exchange ledger + CONTROL pair | done | 252d4411d |
| #step-10 | Deck wire + `ShellSessionStore` + reducer ingest | done | e2f891805 |
| #step-11 | Shell turn rendering | done | 4286ad429 |
| #step-12 | Shell-route submit flip + live cwd chip | done | 7bbac6593 |
| #step-13 | Restore interleave | done | 225f459a4 |
| #step-14 | Share gesture | done | a10c9ad9b |
| #step-15 | Command-block registry skeleton | done | 0ec0d85da |
| #step-16 | Shell e2e + restore app-test | done | ddf95d663 |
| #step-17 | Phase 3 integration checkpoint + docs | done | cb5990a23 |

**Milestone M01: probe findings committed** {#m01-probe} — after #step-2.
**Milestone M02: route chrome shipped** {#m02-chrome} — after #step-7.
**Milestone M03: shell in the transcript** {#m03-shell} — after #step-17.

---

#### Step 1: Shell execution probe {#step-1}

**Commit:** `probe(shell-exec): backend spikes + FINDINGS for block-oriented shell`

**References:** [Q01] backend, [Q02] exchange protocol, [Q03] hardening, [Q04] relaunch semantics, [P04] block shell, [P09] shell session, (#current-state-inventory, #s01-shell-wire)

**Artifacts:**
- `tugrust/crates/tugcast/probes/shell-exec/` — spike scripts for backends (a) tmux-backed and (b) sentinel-driven child, a hardening gauntlet, and `FINDINGS.md` answering Q01–Q04 with evidence.

**Tasks:**
- [ ] Spike (a): bundled tmux (`tmux_server_args()` isolation per `feeds/terminal.rs`) — create session, run a command with an in-pane sentinel (`; printf '\n<SENTINEL> %s %s\n' $? "$PWD"`), capture output; measure boundary reliability, ANSI fidelity, and session survival across a tugcast (tmux-client) restart.
- [ ] Spike (b): long-lived `$SHELL` child over a PTY (or pipes) driven by the same sentinel protocol; measure the same, plus behavior on shell crash/exit.
- [ ] Hardening gauntlet under `PAGER=cat GIT_PAGER=cat TERM=dumb GIT_TERMINAL_PROMPT=0` with stdin from `/dev/null` (or PTY equivalent): `git log` (pager), `ssh localhost` (prompt), `vim` / `htop` (TUI), `sleep 60` (long-runner + kill), `cargo build` (streaming volume). Record what hangs, what leaks control sequences, what the kill path looks like.
- [ ] Verify sentinel protocol on zsh, bash, fish (the `HostFactsStore.shellPath` population).
- [ ] Time capture latency for settled-whole vs chunked reads on a large-output command (informs [Q02] streaming decision).
- [ ] Write `FINDINGS.md`: recommendation per question, with the failure evidence for rejected options.

**Tests:**
- [ ] N/A (probe; findings document is the artifact).

**Checkpoint:**
- [ ] `FINDINGS.md` exists and states an unambiguous recommendation for Q01–Q04, each backed by recorded spike output.

---

#### Step 2: Resolve Q01–Q04; finalize Specs S01/S02/S04 {#step-2}

**Depends on:** #step-1

**Commit:** `plan(update): dash/route-enhancements.md — probe resolutions`

**References:** [Q01]–[Q04], Spec S01, Spec S02, Spec S04, [P07] ledger, [P09] shell session, (#restore-interleave-flow)

**Artifacts:**
- This plan document updated: each Q resolution flipped to DECIDED with the chosen option folded into [P09] (backend), Spec S01 (final frame shapes, streaming or settled), Spec S02 (any schema deltas), Spec S04 (output shape), and [Q04]'s restart-semantics note; affected step Tasks in Phase 3 adjusted to match.

**Tasks:**
- [ ] Fold `FINDINGS.md` recommendations into the plan sections above; leave the Q entries in place marked DECIDED with pointers.
- [ ] Re-check Phase 3 steps (#step-8 – #step-13) against the resolved specs; edit Tasks where the backend choice changes them.

**Tests:**
- [ ] N/A (plan document update).

**Checkpoint:**
- [ ] No Phase 3 step references an unresolved option; grep the plan for `(OPEN)` — only [Q05] (resolved in #step-3) may remain.

---

#### Step 3: `btw` third route in the prompt entry {#step-3}

**Commit:** `tugdeck(routes): btw joins the route choice group`

**References:** [P01] routes are recipients, [Q05] keybinding, (#current-state-inventory)

*(No dependency on Phase 1 — Phase 2 is deck-only and may start in parallel with #step-1.)*

**Artifacts:**
- Three-route `ROUTE_ITEMS` (`{ value: "?", label: "btw", icon: <MessageSquareDashed /> }`), `ROUTE_PREFIX_ALIAS` gaining `"?" → "?"`, `RETURN_ACTION_BY_ROUTE` gaining `"?": "submit"` in `tugdeck/src/components/tugways/tug-prompt-entry.tsx`.
- `SELECT_ROUTE "?"` keybinding in `tugdeck/src/components/tugways/keybinding-map.ts` (⇧⌘B pending [Q05] conflict check; `preventDefaultOnMatch: true`, comment records the check).
- Choice-group geometry tuning so three items sit comfortably (adjust the group's sizing tokens/CSS only as needed; note the current two-item footprint was called "a little too wide").

**Tasks:**
- [ ] Add the route constants + icon import; verify the route-prefix extension flips to `?` when typed at offset 0 (it reads `ROUTE_PREFIX_ALIAS` generically).
- [ ] Add the keybinding after confirming ⇧⌘B is unbound in `keybinding-map.ts` and untrapped in the debug app ([Q05]); pick an alternative modifier combo if trapped and record why.
- [ ] Tune the choice-group width for three items; confirm no Z4A/Z5 shift (the group is leading-fixed).
- [ ] Verify route persistence round-trip: the preserved-state payload stores the route string generically (`coerceRestorePayload` in `tug-prompt-entry.tsx`) — confirm `"?"` restores.

**Tests:**
- [ ] Prompt-entry unit tests: prefix `?` flips route; Return submits on `?`; history entries stamp `route: "?"`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test src/components/tugways/__tests__/ && bunx vite build`
- [ ] In the debug app: click/keyboard/prefix all select `btw`; route survives Developer ▸ Reload.

---

#### Step 4: Per-route submit dispatch {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(routes): per-route submit dispatch — btw asks, shell notices`

**References:** [P02] per-route submit, [D108] (unchanged surface), Risk R01, (#interim-shell-notice)

**Artifacts:**
- `performSubmit` route dispatch in `tug-prompt-entry.tsx`: `❯` → `codeSessionStore.send` (unchanged); `?` → local-command dispatch of `/btw <submitText>` through the existing `RUN_SLASH_COMMAND` responder path (reusing the branch that handles typed local commands — build the command line and follow the same `manager.sendToTarget` flow, then clear the editor); `$` → the interim notice (#interim-shell-notice), draft preserved.
- Empty-input guard on `?` (a bare submit opens the overlay without asking, matching bare `/btw`).

**Tasks:**
- [ ] Implement the dispatch beside the existing local-command branch; keep prefix-strip/trim semantics shared across routes.
- [ ] `?` route: expand atoms via the existing `buildSlashCommandLine` so file mentions survive into the side question.
- [ ] `?` route history push: record the **raw question text** with `route: "?"` — NOT the synthesized `/btw <question>` line — so ↑ recall on the `?` route returns what the user typed, not the command wrapper. (This diverges from the typed-local-command path, which records the `/command` line because that *is* what the user typed; here the `/btw` wrapper is synthetic.)
- [ ] `$` route: adapt the `SHOW_SLASH_COMMAND_NOTICE` surface with shell-specific copy; do not clear the editor.
- [ ] Confirm mid-turn: a `?` submit during a streaming turn dispatches (local commands bypass the send-readiness gate, [D108] [P04]).

**Tests:**
- [ ] Unit: dispatch table routes each of the three routes correctly; `$` preserves the draft; `?` empty-submit opens overlay only.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] Debug app: typing a question on `btw` renders the answer in the side-question overlay, idle and mid-turn; `$` submit shows the notice and keeps the draft.

---

#### Step 5: Per-route Z4B chrome manifest {#step-5}

**Depends on:** #step-3

**Commit:** `tugdeck(routes): per-route Z4B chrome manifest replaces DevRouteShellGate`

**References:** [P03] manifest, [P10] cwd chip, Spec S03, Table T01, Risk R04, [D97] (Z4B occupancy), (#current-state-inventory)

**Artifacts:**
- `tugdeck/src/components/tugways/chrome/dev-route-chrome-manifest.tsx`: renders the Z4B cluster from `useRoute()` + Table T01; hosts the identity badge (never unmounted) and mounts/unmounts the per-route chips.
- `tugdeck/src/components/tugways/chrome/dev-cwd-chip.tsx`: label-top `Cwd` chip (Project-chip grammar: `TugPushButton layout="label-top"`, right-click copy via `useCopyableButton`), reading project dir as its fallback face until Phase 3 binds `ShellSessionStore` ([P10]).
- Third branch in `DevRouteIndicatorBadge` (Table T01's btw row: Claude Code identity), extending the documented single-mount/width-stabilization contract to three faces.
- `DevRouteShellGate` deleted from `dev-card.tsx`; `indicatorsContent` now composes the manifest component (Project chip / `effectivePromptStatusContent` passes into it as the always-present slot).

**Tasks:**
- [ ] Build the manifest component; wire `dev-card.tsx`'s `indicatorsContent` to it, threading the existing chip elements (Session badge, Project content, Mode/Model/Effort chips) as slots so their focus orders and stores stay put.
- [ ] Extend `DevRouteIndicatorBadge` with the btw branch; extend its `TugStableOverlay` reservations to the widest of three faces.
- [ ] Remove all `disabled={isShell}` scatter; confirm the focus cycle (Tab walk) skips unmounted chips cleanly.
- [ ] Verify [L26]: route flips must not remount the identity badge or the surviving chips (React tree shape stable across branches — same component types at same positions per route where shared).

**Tests:**
- [ ] Unit: manifest mapping per route matches Table T01; cwd chip renders fallback face.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] Debug app: flipping code→shell→btw swaps chips per T01 with no visible jump of Z4A or Z5.

---

#### Step 6: Route chrome app-test + geometry {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `app-test(routes): route cycling, chrome manifest, btw round-trip`

**References:** [P01]–[P03], Spec S03, Table T01, Risk R04, (#success-criteria)

**Artifacts:**
- `tests/app-test/at02xx-route-chrome.test.ts` (number from `app-test-inventory.md`): drives the real app — cycles routes via click and ⇧⌘ shortcuts; asserts per-route chip presence/absence by `data-slot`; asserts Z4A group and Z5 submit button rects unmoved across flips; submits a `?` question using the `ingestSideQuestionAnswer` harness and asserts the overlay answer + unchanged transcript entry count (the [D108] invariant beside `at0211`).

**Tasks:**
- [ ] Write the test with real measured geometry (no estimates); reuse `at0211`'s selectors where shared.
- [ ] Register the test in `tuglaws/app-test-inventory.md`.

**Tests:**
- [ ] The app-test itself.

**Checkpoint:**
- [ ] `just app-test at02xx-route-chrome` (from the worktree root) passes.

---

#### Step 7: Phase 2 integration checkpoint + docs {#step-7}

**Depends on:** #step-6

**Commit:** `docs(routes): three-route chrome — tuglaws + design decisions`

**References:** [P01]–[P03], [P10], Table T01, Milestone M02, (#documentation-plan)

**Artifacts:**
- `tuglaws/design-decisions.md`: [D97] Z4A occupant row updated (three routes); a new global entry (or [D108] addendum) recording the `?` route as `/btw`'s second entry point.
- `tuglaws/route-lifecycle.md` updated for three routes + per-route submit dispatch.

**Tasks:**
- [ ] Write the docs; run the full verification battery.
- [ ] Verify the full Phase 2 surface together: routes, dispatch, chrome, persistence, app-tests.

**Tests:**
- [ ] Full suites (aggregate).

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`; `cd tugcode && bun test`; `cd tugrust && cargo nextest run`; `just app-test` (route + btw families) — all green. **Milestone M02.**

---

#### Step 8: tugcast shell service (`feeds/shell.rs`) {#step-8}

**Depends on:** #step-2

**Commit:** `tugcast(shell): block-exec shell service on the reserved SHELL feeds`

**References:** [P04] block shell, [P09] shell session, [Q01]–[Q04] resolutions, Spec S01, (#current-state-inventory)

**Artifacts:**
- `tugrust/crates/tugcast/src/feeds/shell.rs`: per-card shell session — lazy spawn of a **POSIX-shell child in pipe mode** (login shell if bash/zsh, else `/bin/zsh`) in the project dir ([P09]); `SHELL_INPUT` handling (`exec`, `kill`); the **sentinel protocol** (write command + `printf` sentinel emitter, read merged stdout+stderr until the sentinel, parse exit code + cwd); exchange lifecycle emission on `SHELL_OUTPUT` (Spec S01); hardening env + per-command `</dev/null` isolation ([Q03]); per-exchange timeout + pgid signal-kill; `shell_state` liveness frames; teardown on card close; [Q04] restart-fresh-in-project-dir.
- Registration in `feeds/mod.rs` + routing in `router.rs` following the existing feed-wiring pattern.

**Tasks:**
- [ ] Implement the pipe-mode sentinel-protocol child per [P09]/Spec S01. The five probe spikes in `probes/shell-exec/` are the executable reference for the protocol (sentinel format, `</dev/null` wrapping, merged-stream read, hardened env); port that behavior to Rust (`tokio::process::Command` with piped stdio, no PTY).
- [ ] Enforce the hardening env (`PAGER`/`GIT_PAGER`=cat, `TERM=dumb`, `GIT_TERMINAL_PROMPT=0`) and `{ …; } </dev/null` stdin isolation on every exec.
- [ ] Track the running command's pgid; `kill` sends SIGTERM→SIGKILL to it (a wedged foreground can't be cancelled by another write — Q03).
- [ ] Emit `cwd_after` per exchange (sentinel-captured) for the cwd chip.
- [ ] Choose the exec shell defensively: use `$SHELL` only if it is bash/zsh, else `/bin/zsh` (fish and other non-POSIX logins still get a POSIX exec child — Q01 sub-decision).

**Tests:**
- [ ] Rust integration tests: exec round-trip (echo), exit-code capture (false → 1), cwd persistence (`cd /tmp` then `pwd`), the `</dev/null` stdin-isolation case (a `cat` doesn't desync the protocol), kill of a long-runner via pgid signal, TUI decline/timeout path, per-card isolation (two sessions don't share cwd).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` green (with `-D warnings`).

---

#### Step 9: Shell exchange ledger + CONTROL pair {#step-9}

**Depends on:** #step-8

**Commit:** `tugcast(shell): sqlite exchange ledger + list_shell_exchanges CONTROL pair`

**References:** [P07] ledger, Spec S02, (#restore-interleave-flow)

**Artifacts:**
- `tugrust/crates/tugcast/src/shell_ledger.rs`: Spec S02 schema, insert-on-settle from `feeds/shell.rs`, per-session cap with logged eviction, `list_shell_exchanges`/`list_shell_exchanges_ok` CONTROL handlers (following `list_pulse_lines` in `feeds/pulse.rs` and the CONTROL registration pattern in `control.rs`).

**Tasks:**
- [ ] Implement schema + CRUD following `session_ledger.rs` conventions (connection handling, migrations, tests).
- [ ] Stamp `tug_session_id` from the card's current binding at settle time; exchanges on an unbound card are still executed but ledgered under the card's next-bound session only if in flight — settled-while-unbound exchanges log a warning and skip the ledger (edge case; record in code comment).

**Tests:**
- [ ] Rust: insert/list round-trip, cap eviction, per-session isolation, CONTROL pair payload shape.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` green.

---

#### Step 10: Deck wire + `ShellSessionStore` + reducer ingest {#step-10}

**Depends on:** #step-9

**Commit:** `tugdeck(shell): ShellSessionStore + shell_exchange transcript ingest`

**References:** [P06] shell rows, [P12] shell store, Spec S01, Spec S04, (#state-zone-mapping)

**Artifacts:**
- Shell payload codecs in `tugdeck/src/protocol.ts` (Spec S01 frames on `FeedId.SHELL_INPUT`/`SHELL_OUTPUT`).
- `tugdeck/src/lib/shell-session-store.ts`: the card-services triple ([P12]); snapshot owns **session** state `{ live, cwd }` (the in-flight exchange's transcript presence lives in `CodeSessionStore`, not here — [P12]); `exec(command)`, `kill()`; folds `SHELL_OUTPUT` for `shell_state` (cwd/liveness) AND mirrors the exchange lifecycle into `codeSessionStore.ingestShellExchange` on both `exchange_started` and `exchange_complete`.
- `card-services-store.ts`: `shellSessionStore` triple + `_dispose`; `use-dev-card-services.ts` + `dev-card.tsx` threading.
- `code-session-store/types.ts`: `TurnOrigin` widened, `ShellExchangeMessage` added (Spec S04); `code-session-store.ts`: `ingestShellExchange(event)` public method dispatching a reducer event with `phase: "started" | "complete"` keyed by `exchange_id` — `started` mints an **uncommitted** shell-origin turn at the live edge, `complete` settles that same turn in place (output + `exitCode` + `cwdAfter`); a killed exchange settles with `exitCode: null` ([P12]).

**Tasks:**
- [ ] Implement codecs, store, ingest; fix every exhaustive `TurnOrigin`/`Message` match the compiler surfaces (selectors, data source, renderers).
- [ ] Reducer: mint-then-settle keyed by `exchange_id`; a `complete` with no prior `started` (defensive — e.g. a restore settle, [P07]) mints-and-settles in one step.
- [ ] `/clear` and card teardown reset `ShellSessionStore` in-memory state (the ledger is untouched — it keys by session).

**Tests:**
- [ ] Unit: codec round-trip; reducer mint-then-settle by `exchange_id` (started → uncommitted turn present; complete → same turn settled with exit code; killed → `exitCode: null`); restore-shaped bare `complete` mints-and-settles; `/clear` reset. (Rendering assertions belong to #step-11 unit + #step-16 app-test, not here.)

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`

---

#### Step 11: Shell turn rendering {#step-11}

**Depends on:** #step-10

**Commit:** `tugdeck(shell): shell exchange rows — TerminalBlock-based, non-context ink`

**References:** [P06] shell rows, [P11] doctrine, Spec S04, (#current-state-inventory)

**Artifacts:**
- `shell-exchange-block.tsx` (+ css): composes `TerminalBlock` (static mode; streaming per [Q02] if resolved that way) with the command as `headerLabel`, exit-code/duration footer badges, distinct non-context framing (shell gutter icon per the `TugTranscriptEntry` participant iconography — the `Shell` lucide glyph the choice group already uses; subdued frame tokens).
- `DevTranscriptDataSource` shell row kind; Z1A trailing for shell turns renders exit code + duration (not model/timestamp), Z1B/Z1C pass `null`.

**Tasks:**
- [ ] Implement block + row projection. The in-flight exchange is an **uncommitted shell turn already in the `CodeSessionStore` snapshot** ([P12] — minted on `exchange_started`), so `DevTranscriptDataSource` stays single-snapshot: an uncommitted shell turn projects the live-edge row (command shown, output streaming/pending, no exit code yet), and the `exchange_complete` settle swaps it to the settled row in place. No second-store composition in the data source.
- [ ] Distinguish the in-flight vs settled shell-block face off the message's `exitCode === null` + committed flag (mirrors how the assistant live edge reads its in-flight state).
- [ ] Style per theme tokens (all six themes; `bun run audit:theme-contrast` if new tokens are added).

**Tests:**
- [ ] Unit (pure-logic `bun:test`, NO fake-DOM render): `DevTranscriptDataSource` projection maps a shell-origin turn to the shell row kind, in-flight and settled; the block's pure view-derivation (command/exit-code/duration → header + footer fields) from a fixture `ShellExchangeMessage`. Actual rendered-DOM assertions are deferred to #step-16's app-test (real app) per the project test doctrine — no `jsdom`/RTL render here.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] Debug app (with #step-12's flip or a harness ingest): a shell exchange renders as a distinct transcript row, in-flight then settled.

---

#### Step 12: Shell-route submit flip + route-aware Z5 + live cwd chip {#step-12}

**Depends on:** #step-10, #step-11, #step-5

**Commit:** `tugdeck(shell): $ route executes; route-aware submit button; cwd chip goes live`

**References:** [P02] dispatch, [P13] route-aware submit, [P10] cwd chip, Risk R01, [L26], (#interim-shell-notice)

**Artifacts:**
- The `$` branch of the per-route dispatch replaced: `shellSessionStore.exec(submitText)` (notice branch deleted).
- **Route-aware submit-button mode selector** ([P13]) in `tug-prompt-entry.tsx`: a wrapper that picks the `DevSubmitButtonMode` fed to `resolveSubmitButtonView` (`tug-prompt-entry-submit-button.ts`) from either the Claude session lifecycle (`❯`/`?` routes — today's path, unchanged) or a `ShellSessionStore`-derived mode (`$` route — an exchange in flight → `stop`; otherwise `submit`). The pure `resolveSubmitButtonView` projection is untouched; only its *input* becomes route-conditional. Z5 stays one DOM node ([L26]); `stop` on `$` fires `kill()`. Serial exec: a second `$` submit while running is refused because the button is in `stop`, not `submit` (no queue; the `+` mid-turn button stays code-route-only).
- `dev-cwd-chip.tsx` bound to `ShellSessionStore.cwd` via `useSyncExternalStore` (fallback face retained pre-spawn).

**Tasks:**
- [ ] Flip the dispatch; implement the route-aware mode selector; wire `stop` on `$` to `kill()`.
- [ ] Confirm the Claude-route Z5 behavior is byte-for-byte unchanged (the selector is a pass-through on `❯`/`?`).
- [ ] Bind the chip; verify width stability as cwd changes (end-truncate long paths, full path in `title`/right-click copy).

**Tests:**
- [ ] Unit (pure-logic `bun:test`, NO fake-DOM render): the route-aware mode selector — `$` + in-flight → `stop`, `$` + idle → `submit`, `❯`/`?` → passes the Claude lifecycle mode through unchanged; `$`-route dispatch calls `shellSessionStore.exec`; the cwd chip's face-string derivation follows a `ShellSessionStore` snapshot's `cwd` (string → face, not a rendered chip). Chip-in-DOM and end-to-end exec assertions are #step-16's app-test.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] Debug app: `ls` on the `$` route executes and renders; a long-runner (`sleep 5`) shows the `stop` pose and a second submit is refused until it finishes or is killed; `cd tugdeck` then `pwd` shows cwd statefulness and the chip updates; `❯`/`?` submit behavior is visibly unchanged.

---

#### Step 13: Restore interleave {#step-13}

**Depends on:** #step-10

**Commit:** `tugdeck(shell): restore-time interleave of ledgered exchanges`

**References:** [P07] ledger interleave, Risk R02, Spec S02, (#restore-interleave-flow)

**Artifacts:**
- CONTROL client for `list_shell_exchanges` in the deck (following the existing CONTROL request/response client pattern used by `list_pulse_lines`/`list_card_bindings` consumers); interleave in `CodeSessionStore`'s restore path per #restore-interleave-flow (fetch on/after `replay_complete`, merge-sort by timestamp, source-stable tiebreak, turns minted through the same reducer event as live ingest).

**Tasks:**
- [ ] Implement fetch + interleave; guarantee HMR does not re-run it (restore-path-only trigger, matching the existing replay lifecycle hooks in `dev-card-restore-gate.ts` / `dev-session-restore.ts`).
- [ ] Handle the empty-ledger and ledger-only (no Claude turns yet) cases.

**Tests:**
- [ ] Unit: interleave ordering fixtures — shell rows between turns, before first turn, after last turn; same-timestamp tiebreak; idempotence (running restore twice never duplicates rows).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] Debug app: run Claude turn → shell command → Claude turn; Developer ▸ Reload reproduces the exact row order.

---

#### Step 14: Share gesture {#step-14}

**Depends on:** #step-11

**Commit:** `tugdeck(shell): on-demand share — compose an exchange into the prompt entry`

**References:** [P08] share gesture, [P11] doctrine, (#non-goals)

**Artifacts:**
- A **Share** affordance in the shell exchange block's chrome (beside Copy): sets the route to `❯` (via `RouteLifecycle.setRoute` through the prompt entry's exposed handle or responder action), inserts a fenced `command + output + exit code` block into the editor for the user to edit and send. Truncation for oversized outputs (cap with a "…truncated" marker; full output stays in the row).

**Tasks:**
- [ ] Implement using the existing editor insertion API (the same surface `/btw`'s overlay and atoms use for programmatic content); never auto-send.

**Tests:**
- [ ] Unit: share composes the expected text and flips the route; oversized output truncates.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] Debug app: Share on an exchange lands editable content in the code-route editor.

---

#### Step 15: Command-block registry skeleton {#step-15}

**Depends on:** #step-11

**Commit:** `tugdeck(shell): COMMAND_BLOCK_REGISTRY skeleton on the D101 grammar`

**References:** [P05] registry, [D101] visibility policy grammar, (#non-goals)

**Artifacts:**
- `dev-command-block-registry.ts`: `registerCommandBlock(matcher, renderer)` + `resolveCommandBlock(command)` defaulting to the generic shell exchange block; a governance test pinning the classification rules (no double registration; default is total). No bespoke renderers ship ([P05] — follow-ons).

**Tasks:**
- [ ] Implement registry + resolution in the shell exchange block's render path.

**Tests:**
- [ ] Governance test per [D101]'s test shape (`__tests__/dev-tool-visibility-policy.test.ts` as the model).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`

---

#### Step 16: Shell e2e + restore app-test {#step-16}

**Depends on:** #step-12, #step-13

**Commit:** `app-test(shell): exchange e2e + restore interleave order`

**References:** [P06], [P07], Risk R02, (#success-criteria)

**Artifacts:**
- `tests/app-test/at02xx-shell-route.test.ts`: real app — submit `echo`/`cd`/`pwd` on the `$` route; assert transcript rows (command, output, exit code) and cwd chip; interleave a Claude turn; Developer ▸ Reload; assert identical row order and shell row content; assert shell rows carry the non-context styling hook (`data-` attribute).
- Registration in `tuglaws/app-test-inventory.md`.

**Tasks:**
- [ ] Write the test (fast, exiting; no real-claude dependency — use the harness's session tooling for the Claude turn or scope to shell rows + reload if a real turn is too heavy).

**Tests:**
- [ ] The app-test itself.

**Checkpoint:**
- [ ] `just app-test at02xx-shell-route` (from the worktree root) passes.

---

#### Step 17: Phase 3 integration checkpoint + docs {#step-17}

**Depends on:** #step-14, #step-15, #step-16

**Commit:** `docs(shell): transcript doctrine + shell service — tuglaws, design decisions, memory`

**References:** [P04]–[P12], Milestone M03, (#documentation-plan, #success-criteria)

**Artifacts:**
- `tuglaws/design-decisions.md`: the global doctrine entry ([P11]) + shell-in-transcript decision (service, ledger, interleave, share gesture, registry), cross-referencing [D97]/[D101]/[D108].
- `#s` marked active in the addressing doc; `route-lifecycle.md` final state; app-test inventory entries verified.
- Auto-memory reference entry for the shell service + ledger.

**Tasks:**
- [x] Write docs; sweep the plan's Step Status Ledger to `done` with commit hashes.
- [x] Full verification battery across every suite.

**Tests:**
- [x] Full suites (aggregate).

**Checkpoint:**
- [x] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build` (4140 pass, tsc clean, build clean); `cd tugcode && bun test` (761 pass); `cd tugrust && cargo nextest run` (1122 pass); `just app-test at0215 at0216` (VERDICT PASS) — all green. **Milestone M03.**

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A Dev card with three real routes — `❯` code (unchanged), `$` shell (block-oriented execution threading durable, visually distinct exchanges into the transcript, with live cwd chrome and an on-demand share gesture), and `?` btw (the native side-question surface) — each with route-appropriate Z4B chrome.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Probe FINDINGS.md committed; Q01–Q04 DECIDED in this document (M01).
- [x] Three-route chrome shipped with per-route Z4B manifest and passing geometry app-test (M02).
- [x] Shell exchanges execute, render, persist, and interleave identically across live / Developer ▸ Reload / relaunch, with share gesture and registry skeleton (M03).
- [x] All suites green: tugdeck + tugcode `bun test`, `cargo nextest run`, `bunx vite build`, `just app-test`.

**Acceptance tests:**
- [x] `at0215-route-chrome` (route cycling, chrome manifest, btw round-trip).
- [x] `at0216-shell-route` (exchange e2e, cwd, restore interleave order).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Bespoke command renderers (`git status`, `ls`, build-progress blocks) via the registry.
- [ ] Streamed live output for long-running commands (if [Q02] resolved settled-whole for v1).
- [ ] Pinnable WORK popover (tabled from the originating discussion).
- [ ] Shell-history recall integration (↑ on the `$` route already scopes per route; deeper shell-native history is a follow-on).

| Checkpoint | Verification |
|------------|--------------|
| M01 probe | `FINDINGS.md` + plan Q resolutions committed |
| M02 chrome | `just app-test at02xx-route-chrome` |
| M03 shell | `just app-test at02xx-shell-route` + full suites |
