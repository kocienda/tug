<!-- tugplan-skeleton v2 -->

## Dev-Card / Claude Code Parity {#dev-card-claude-code-parity}

**Purpose:** Close the experience gap between Claude Code's terminal TUI and the dev-card by landing the chrome (permission-mode / model / rate-limit / session badges in Z4B with `Shift+Tab` cycling), reimplementing the slash commands the terminal renders locally (`/rewind`, `/resume`, `/diff`, `/permissions` rules editor, `/context` HUD, `/memory`, `/agents`, `/mcp`, `/hooks`), and polishing the streaming + approval surface (`control_request_forward` UI, `api_retry`, `thinking_text` empty-state, `@`-file completion, image drag/paste).

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-05-28 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dev-card has been a faithful streaming-conversation surface for months — user types, claude streams back, tool calls render as structured blocks — but it stops at "transcript." Everything around the transcript that makes Claude Code feel like a tool you *control* (permission mode, session lifecycle, plan-mode workflow, slash commands that produce zero stream-json events) is either missing or hardcoded. The 35-probe transport-exploration catalog ([transport-exploration.md](transport-exploration.md)) and the freshly-landed v2.1.154 golden baseline (commit `3b925484`) give us complete coverage of what events flow and what's terminal-rendered-locally; this plan turns that knowledge into a phased build-out.

Three things changed recently that make this the moment to close the gap. First, the stream-json baseline is fresh — we know exactly what 2.1.154 emits, what's new (`rate_limit_event`, new tools surfaced in `system/init`, `claude-opus-4-8[1m]` model identifier), and where the differ tolerates variance. Second, tugcode now forwards new event types we can build chrome on — commit `9af307fe` added `RateLimitEvent` passthrough, the per-turn subscription-quota broadcast we lacked plumbing for. Third, the Z4B prompt-indicator slot is wired (`dev-card.tsx:2391-2401`) and sitting empty in most cards — waiting for the permission-mode badge, the model badge, the rate-limit countdown, and the session-state chip.

#### Strategy {#strategy}

- **Z4B horizontal space groundwork first** ([#step-0]): Z4B is already at 3 single-line pills today; the four new chips would overflow. Before any chip lands, enhance `TugBadge` to support a two-line `LABEL` / `content` presentation borrowing the status-bar's letter-spaced label typography. This is a design mini-spike (`gallery-badge` demos + a tuglaws note) — no production-chip mount yet, but every subsequent chip step depends on it.
- **Foundations after the primitive** ([#step-1] through [#step-5]): land the Z4B chrome as INDICATORS only per [#d13-z4b-indicator-only] (permission-mode, model, rate-limit, session-state). All four read from `SessionMetadataStore` via the same `useSyncExternalStore` pattern AND render through the two-line TugBadge from [#step-0] — doing them together amortizes the plumbing and the placement-experiment harness churn.
- **`Shift+Tab` cycle matches terminal exactly** ([#d02-cycle-order]) — `default → acceptEdits → plan → auto`. Preserves muscle memory for users migrating from the terminal.
- **Slash commands split by category** ([#l01-slash-cmd-inventory]): skill-backed (no work, they already produce real event streams), terminal-rendered-locally (reimplement as graphical surfaces — the meat of this plan), unsupported (hidden from popup per [#d14-slash-unsupported-list]; documented in a canonical list).
- **`/rewind` matches the terminal empirically** ([#d10-rewind-matches-terminal]) — run a probe to capture what the terminal does, then design the dev-card flow to produce the same mutations. No protocol speculation.
- **`/rewind` and `/resume` use *different* sheets** ([#step-7]/[#step-8]) — they are distinct operations, proven so by [#step-7a]. `/resume` reuses the session chooser ([#d05-session-picker-sheet], a list of *distinct sessions*); `/rewind` needs its own `RewindSheet` (a *turns-in-this-session* picker with per-turn diff stats, plus a restore-options confirm form). Both are card-scoped overlays per [#d15-pane-sheets-are-overlays]. (Earlier drafts lumped them under one primitive — retired.)
- **Stream-side polish is cheap and high-impact** ([#step-15] through [#step-22]): `control_request_forward` UI, `api_retry` indicator, `thinking_text` empty-state, `@`-file completion, image drag/paste, `unknown_event` IPC frame. Each is a small targeted change against a stable IPC contract.
- **Round-trip mutations via tugcode** ([#d03-roundtrip-mutations]) — the badge updates from the post-mutation `system_metadata` refresh, not from the keypress directly. Keeps state truthful even if a mode change races a concurrent turn.
- **Phase boundaries are shippable.** Phase A unlocks the chrome story; Phase B unlocks "I can do what I do in the terminal"; Phase C polishes the streaming / approval surface that's been getting by on minimums. Each phase ships independently.

#### Success Criteria (Measurable) {#success-criteria}

- The Z4B indicator cluster on a freshly-mounted dev-card shows a permission-mode chip with the current mode label within 200 ms of session ready — verify by mounting a card with [session-metadata-feed.md](session-metadata-feed.md)'s snapshot feed and observing the chip text before the first turn fires.
- `Shift+Tab` in a focused dev-card cycles the permission mode through `default → acceptEdits → plan → auto → default` in order — verify with a real-claude round-trip test that asserts the chip label flips after each press and that `system_metadata.permissionMode` confirms.
- The model badge shows the active model (e.g. `Opus 4.8 · 1M`) sourced from `system_metadata.model` — verify the badge updates after a `model_change` round-trip.
- A `rate_limit_event` with `status: "allowed"` and `resetsAt` > 1 hour away does NOT render a chip; status `≠ "allowed"` or `resetsAt` within 60 min DOES render the chip — verify with mocked `RateLimitEvent` payloads via a tugcode probe.
- Typing `/rewind` in the prompt entry opens a pane-sheet listing the current session's committed turns, ordered most-recent first, with timestamps and previews — verify by sending `user_message{content: [{type:"text",text:"/rewind"}]}` and asserting the sheet mounts before any IPC round-trip.
- Picking a turn in the rewind sheet and choosing a restore action sends `session_rewind{promptUuid, scope}` ([#q04-rewind-protocol], resolved empirically in [#step-7a]; `promptUuid` is claude's user-prompt-record uuid, surfaced additively per [#step-7]): `scope:"code"` → tugcode issues a `rewind_files` control request that reverts the files claude edited; `scope:"conversation"` → tugcode truncates the session JSONL to that turn and silent-respawns `--resume` — verify end-to-end with a real-claude test asserting (code) a file claude wrote is reverted, and (conversation) the resumed session recalls only the retained turns.
- A permission denial (`control_request_forward` with `is_question: false`) opens a modal popover anchored to the in-flight tool block with the tool name, input preview, decision reason, allow/deny buttons, and any `permission_suggestions[]` rules as one-click options — verify with the test-08 / test-11 probe shapes.
- `api_retry` events render a transient **card-level banner** (not a Z4B chip) with `attempt n/max`, `retry_delay_ms` countdown, and `error` label — verify by replaying a probe with an injected `api_retry` event and asserting the banner mounts, ticks down, and clears on `turn_complete` or `cost_update`.
- The drift regression (`stream_json_catalog_drift_regression`) stays clean across the work — verify after each step's commit lands.
- All four phases ship as separable PRs. Phase A is mergable without B or C; B without C; C standalone. Verify by reviewing the [#deliverables] checkpoint table per phase.

#### Scope {#scope}

1. Z4B chrome groundwork: enhance `TugBadge` to support a two-line `LABEL` / `content` layout in both orderings, borrowing the status-bar legend typography ([#step-0]).
2. Z4B chrome (rendered via the two-line `TugBadge` / `TugPushButton`): permission-mode chip (cycle via `Shift+Tab` / `/permissions`), model chip (change via `/model` or chip press), effort chip ([#step-4]; interactive reasoning-effort control). The rate-limit chip was reverted in favor of an app-level banner ([#step-3.5]); session-state refinement was cancelled (lifecycle states live in the status bar).
3. Locally-rendered slash command reimplementation: `/rewind` (empirically modeled on terminal — see [#d10-rewind-matches-terminal]), `/resume`, `/permissions` rules editor, `/model` picker, `/diff` sheet, `/context` HUD, `/memory` / `/agents` / `/hooks` listing sheets, `/help` tabbed sheet, `/btw` exclude-from-history flow, `/clear`.
4. Stream-side polish: `control_request_forward` UI for tool approval and AskUserQuestion, `api_retry` indicator, `thinking_text` empty-state (omit per [#d12-thinking-empty-state]→[#q12-thinking-empty-state]), `@`-file completion, image drag/paste, interrupt visibility, `compact_boundary` divider, `unknown_event` IPC frame + frontend banner.
5. Slash-command popup filtering: unsupported commands hidden from the popup per [#d14-slash-unsupported-list]; canonical list of unsupported commands lives in repo docs.
6. Sheets (card-scoped overlays per [#d15-pane-sheets-are-overlays]): the existing session chooser (`dev-picker-cells.tsx`) for `/resume`; a **dedicated `RewindSheet`** (turn picker + restore-options confirm form) for `/rewind` — separate sheets, not a shared primitive ([#step-7a]).
7. Tugcast `git_diff_request` / `git_diff_response` control commands for `/diff` per [#d21-diff-dedicated-command].

#### Non-goals (Explicitly out of scope) {#non-goals}

- Multi-card multi-instance coordination of tugcode processes — covered by [tug-multi-instance.md](tug-multi-instance.md).
- Tug-feed structured-progress reporting — covered by [tug-feed.md](tug-feed.md).
- Browser-frontend vs Tug.app-host division-of-labor: this plan describes *what* the dev-card shows; *where* the dev-card runs stays the host's concern.
- Settings / config UI for hooks, theme tokens — these belong to the host-app settings surface (Tug.app), not the dev-card.
- Subagent-tree visualization, turn-level cost breakdown chips, inline tool-result panes, plan-mode card-style workflow, skill-output trees — listed as [#roadmap] follow-ons but explicitly out of scope here.
- **MCP in any form.** `/mcp` slash command, MCP listing sheet, MCP auth UI — all dropped (per [#q06-mcp-auth-ownership]). Picked up in a future MCP-focused plan.
- The hunk-level "stage" affordance on `/diff` — tugcast doesn't have a `stage hunk` command yet; tracked as a future ask.
- Z4B chip click-to-open behaviors — Z4B is indicator-only per [#d13-z4b-indicator-only]. No model picker on chip click; no permission-mode popover on chip click.

#### Dependencies / Prerequisites {#dependencies}

- v2.1.154 golden catalog (committed in `3b925484`) — the protocol baseline this plan is anchored against per [D06].
- `rate_limit_event` IPC passthrough (committed in `9af307fe`) — the chrome consumer this plan builds on.
- [session-metadata-feed.md](session-metadata-feed.md) snapshot-feed proposal — recommended (not required) for the Z4B chips to populate before the first turn; without it, chips show a transient `"…"` state. With [D07]'s per-card persistence, the chip can pre-populate from tugbank as soon as the card mounts, before metadata round-trips.
- `SessionMetadataStore` (`tugdeck/src/lib/session-metadata-store.ts`) — the store every Z4B chip reads.
- `code-session-store` / `code-session-store.ts` and the `code-session-store/` reducer — owns transcript state for `/rewind` to read.
- `routeTopLevelEvent` in `tugcode/src/session.ts:612` — where new IPC translations land (rewind shape per [D10] / [#step-7a], unknown_event per [D19] / [#step-22]).
- `gallery-sheet.tsx`, `gallery-tooltip.tsx`, `gallery-radio-group.tsx`, `gallery-list-view.tsx`, `tug-arc-gauge.tsx` (reused by the `/context` HUD per [D22]) — existing gallery primitives consumed throughout.
- `feeds/FILESYSTEM 0x10` snapshot feed — the data source for `@`-file completion ([#step-18]).
- Tugbank `dev.permission-mode.<cardId>` namespace — for per-card mode persistence per [D07].

#### Constraints {#constraints}

- **Tuglaws compliance.** All React/DOM work must honor [tuglaws.md](../tuglaws/tuglaws.md). Specifically: external state enters React through `useSyncExternalStore` only ([L02]); registrations that events depend on use `useLayoutEffect` ([L03]); appearance changes go through CSS/DOM, never React state ([L06]). Z4B badges are `useSyncExternalStore` consumers of `SessionMetadataStore`.
- **AskUserQuestion ≤4-option cap.** Per [CLAUDE.md](../CLAUDE.md), AskUserQuestion is Zod-capped at 4 options per question. The `control_request_forward` polish in [#step-15] must honor this; renderer must salvage gracefully when an agent exceeds it.
- **Single text-entry destination.** Per `feedback_persistent_text_entry` memory, one *saved/restored* focus destination per card. The slash-command modal pane sheets must not steal that destination; transient modals carry their own text inputs but yield focus back on dismiss.
- **Substrate responder registration.** Per `feedback_substrate_responder` memory, any document-level capture-phase keyboard interception must register as a substrate responder. The `Shift+Tab` cycle handler in [#step-1] is a substrate responder.
- **Z4B chips are NOT width-stabilized (deliberate).** The `feedback_fixed_width_buttons` memory governs *buttons* whose content varies by state; the Z4B indicator chips opt out. They render as two-line `TugBadge` (`label-top`, `size="sm"`, `role="agent"`) whose width tracks its current content — cycling the permission mode or ticking the rate-limit countdown reflows the chip, and that is accepted. See [#r01-z4b-layout-shift].
- **No localStorage.** Per `feedback_no_localstorage` memory, persistent state flows through `tugbank /api/defaults/<domain>/<key>`. Per-card permission-mode persistence ([#q01-mode-persistence]) uses tugbank.
- **HMR is always running.** Per `feedback_hmr` memory, no manual `bun run build` for tugdeck. Tugcode changes require recompile (per `feedback_tugcode_compile`).
- **Tests use real engine / real claude.** Per `feedback_test_reality`, `feedback_no_mock_store_tests`, `feedback_no_happy_dom_tests`. Phase A / B / C tests are `bun:test` pure-logic + real-app `just app-test` per `feedback_just_app_test`.

#### Assumptions {#assumptions}

- Claude Code 2.1.x retains the `system/init` shape with `claude_code_version`, `model`, `permissionMode`, `slash_commands`, `agents`, `skills`, `plugins`, `mcp_servers`, `memory_paths` for the duration of this plan. The drift regression will catch deviation.
- Tugcode's `permission_mode`, `model_change`, `session_command`, `tool_approval`, `question_answer`, and `interrupt` inbound types are stable. No protocol changes required for Phase A or C; only [#q04-rewind-protocol] in Phase B may add `session_rewind`.
- The `FILESYSTEM` snapshot feed's content shape is suitable for `@`-file completion without modification.
- `rate_limit_event` shape stays as captured in v2.1.154 (`{status, resetsAt, rateLimitType, overageStatus, overageDisabledReason?, isUsingOverage}`); strict-typed receiver in tugcode catches shape drift.
- Image drag/paste already-shipped `image-downsample.ts`, `atom-bytes-store.ts`, `synthesize-user-message.ts` continue to work post Step-5c.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan format relies on **explicit, named anchors** and **rich `References:` lines** in execution steps. Conventions follow [tugplan-skeleton v2](../tuglaws/tugplan-skeleton.md):

- Anchors are explicit `{#anchor-name}` suffixes on headings, lowercase kebab-case, semantic and renumber-stable.
- Stable IDs: decisions `[D01]`, open questions `[Q01]`, specs `S01`, tables `T01`, lists `L01`, risks `R01`, milestones `M01` (two-digit, no reuse).
- Execution-step dependencies use `**Depends on:** #step-N` anchor references, never titles or line numbers.
- Execution-step references cite by ID and anchor (e.g. `[D02] cycle order, Spec S03, (#strategy)`).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

> Each question is described enough that a "yes/no" or "choose option X" lands without follow-up. The user marks `OPEN → DECIDED` in review.

#### [Q01] Per-card vs per-session permission-mode persistence (DECIDED) {#q01-mode-persistence}

**Question:** When the user cycles the permission mode in card A and quits, should a freshly-opened card A reload in the same mode (per-card persistence in tugbank) or in `default` (per-session reset, matching the terminal)?

**Resolution:** DECIDED → **per-card persistence via tugbank `dev.permission-mode.<cardId>`.** Survives card relaunch. See [#d07-per-card-mode-persistence].

#### [Q02] `rate_limit_info` — own store or extend SessionMetadataStore (DECIDED) {#q02-rate-limit-store}

**Question:** Add a `rateLimit` field to `SessionMetadataSnapshot` or stand up a parallel `RateLimitStore`?

**Resolution:** DECIDED → **extend `SessionMetadataSnapshot.rateLimit: RateLimitInfo | null`.** Single source of truth, single subscription pattern. See [#d04-session-metadata-hub].

#### [Q03] Model-change synthetic confirmation — transcript or banner (DECIDED) {#q03-model-confirm}

**Question:** Tugcode emits a synthetic `assistant_text` "Set model to claude-…" after `model_change`. Render it in the transcript (audit trail, matches terminal) or as a transient banner that fades (cleaner history)?

**Resolution:** DECIDED → **render in the transcript. Match the terminal.** Audit trail preserved; no banner. See [#d09-model-confirm-in-transcript].

#### [Q04] `/rewind` protocol shape (DECIDED) {#q04-rewind-protocol}

**Question:** How does the dev-card tell tugcode "fork from message X"?

**Resolution:** DECIDED → **match the Claude Code terminal empirically.** Run a capture probe that drives `/rewind` in the terminal, observe what flows on the wire / what claude / harness state mutates, and design the dev-card flow to produce the same mutations. This becomes a prerequisite investigation step before [#step-7] designs the sheet. See [#d10-rewind-matches-terminal] and [#step-7] artifacts.

**Empirical answer ([#step-7a], 2026-05-30, claude 2.1.158).** `/rewind` has **two dimensions**, and answering "fork from message X" depends which:
- **Conversation** — client-driven in tugcode: truncate the `parentUuid`-chained session JSONL at the chosen turn and respawn (`--resume`, or `--fork-session` to branch). Nothing forwarded to claude. The typed `/rewind` string itself just bounces (`"/rewind isn't available in this environment."`).
- **Code** — a real **`rewind_files` control request** to claude (`{subtype:"rewind_files", user_message_id, dry_run?}` → `{canRewind, filesChanged, insertions, deletions}`), gated on `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`. This *does* cross the wire; the first-pass conclusion "no claude-facing protocol required" was wrong.

So the dev-card `session_rewind` inbound carries a `scope` and tugcode dispatches per dimension. Full writeup: [transport-exploration.md#rewind-files-control-request](transport-exploration.md#rewind-files-control-request).

#### [Q05] `/btw` out-of-history turn shape (DECIDED) {#q05-btw-shape}

**Question:** Terminal `/btw` runs a turn that doesn't persist to session history. Does our journal need an `exclude_from_history` flag, do we synthesize a separate ephemeral session, or do we write to history with a hint?

**Resolution:** DECIDED → **exclude flag**. Add `metadata.exclude_from_history: true` on the `user_message`. **Sub-investigation required**: probe claude 2.1.154 to see whether it honors the flag natively; if absent, tugbank-only filtering carries the exclusion. See [#d11-btw-exclude-flag] and [#step-13] task list.

#### [Q06] MCP auth flow ownership (DECIDED) {#q06-mcp-auth-ownership}

**Question:** When the user clicks "Authenticate" on an MCP row in the `/mcp` sheet, where does the OAuth webview live — in-card iframe or host-app surface?

**Resolution:** DECIDED → **MCP is fully out of scope.** No `/mcp` sheet in this plan; no auth flow design. `/mcp` is dropped from [#l01-slash-cmd-inventory] and from [#step-12] scope. Surface returns when MCP is addressed in a future plan. See [#non-goals].

#### [Q07] `bypassPermissions` in the `Shift+Tab` cycle (DECIDED) {#q07-bypass-in-cycle}

**Question:** The terminal's `Shift+Tab` cycle is 4-way and excludes `bypassPermissions` / `dontAsk`. Match exactly?

**Resolution:** DECIDED → **4-way cycle matching the terminal exactly.** `bypassPermissions` not in cycle, not surfaced in dev-card (no popover access path either — see [#q08-model-scope] precedent: Z4B is indicator-only). See [#d02-cycle-order].

#### [Q08] Z4B-as-picker vs Z4B-as-indicator (DECIDED) {#q08-model-scope}

**Question (clarified during review):** Is Z4B a picker surface where the user can switch model directly, or strictly an indicator that displays the current model?

**Resolution:** DECIDED → **Z4B is INDICATOR-ONLY**, not a picker. Model is switched only via the `/model` slash command, which opens its own picker sheet. The Z4B model chip displays the active model and that's all. Same policy applies to the permission-mode chip: the chip displays mode; mode changes go through `Shift+Tab` (cycle) or `/permissions` (popover). No click-to-change on any Z4B chip. See [#d13-z4b-indicator-only] and [#step-2].

The original question about model-scope (card vs session) is consequently moot — there's no card-scoped picker to scope. Model changes via `/model` route to `model_change` IPC which is session-scoped per the existing protocol.

#### [Q09] Slash-popup filtering policy (DECIDED) {#q09-slash-popup-filter}

**Question:** `SessionMetadataStore.getCommandCompletionProvider()` exposes every command claude reports. Some have no graphical analog. Hide, grey, or include?

**Resolution:** DECIDED → **Hide unsupported commands from the popup; maintain a list of unsupported commands in repo docs.** The dev-card slash popup shows only commands with a working graphical surface. Unsupported commands (e.g. `/vim`, `/theme`, `/color`) are absent from the popup and produce no behavior if typed verbatim. The canonical list of unsupported commands lives in a new docs section so users can find it. See [#d14-slash-unsupported-list] and [#documentation-plan].

#### [Q10] Pane-sheet anchor — split-pane right half or overlay (DECIDED) {#q10-pane-sheet-anchor}

**Question:** Does the right-half of the dev-card's existing horizontal split-pane (`dev-card.tsx:2425`) become the sheet surface, or do we add a separate sheet abstraction that overlays?

**Resolution:** DECIDED → **Overlay**. Pane sheets do NOT split the dev-card horizontally. Sheets mount as overlays on top of the transcript / prompt area. The existing horizontal split (`dev-card.tsx:2425`) stays untouched and is reserved for its current use (top transcript pane / bottom prompt entry). See [#d05-session-picker-sheet] (updated) and [#d15-pane-sheets-are-overlays].

#### [Q11] Drop list for terminal-only commands (DECIDED) {#q11-drop-list}

**Question:** Beyond `/vim`, `/theme`, `/color`, should `/clear`, `/quit`, `/help` also be hidden from the popup?

**Resolution:** DECIDED → **`/clear` supported.** **`/help` supported as a tabbed sheet** similar in content to what Claude Code offers (categorized command list, key shortcuts, links to docs). `/quit` not in scope here (close-card is the affordance; revisit if needed). `/vim`, `/theme`, `/color` dropped per [#q09-slash-popup-filter]. See [#d16-clear-help-supported] and [#step-13].

#### [Q12] `thinking_text` empty-state policy (DECIDED) {#q12-thinking-empty-state}

**Question:** When a turn produces no thinking, render an empty collapsible header or omit entirely?

**Resolution:** DECIDED → **Omit**. No empty header. The thinking collapsible exists when thinking deltas arrived; absent otherwise. See [#step-17].

#### [Q13] `RateLimitEvent` shape strictness vs forward-compat (DECIDED) {#q13-rate-limit-strictness}

**Question:** Strict-typed shape or loose pass-through?

**Resolution:** DECIDED → **Keep strict.** Quality gate; capture-capabilities runbook catches drift. See [#d18-rate-limit-strict-shape].

#### [Q14] Unknown-event-type IPC frame for forward-compat (DECIDED) {#q14-unknown-event-ipc}

**Question:** Add an `unknown_event` IPC frame for the default branch of `routeTopLevelEvent`?

**Resolution:** DECIDED → **Add the frame.** Replace the silent log-and-drop with an `unknown_event` IPC carrying `original_type` and a hex preview. Frontend surfaces a soft warn banner. See [#d19-unknown-event-frame] and [#step-22].

#### [Q15] Multi-card-same-session story scope (DECIDED) {#q15-multi-card-session}

**Question:** When two cards bind to the same session, who owns the send button, the interrupt button, the prompt entry, and the keyboard focus?

**Resolution:** DECIDED → **Two cards cannot connect to the same session.** Session binding is 1:1 with card. The question is structurally impossible and therefore non-existent. Reference removed from [#non-goals]; the design constraint surfaces here in [#d20-one-card-per-session]. Related Q08 simplification also holds — model is session-scoped, session is card-scoped, model is therefore card-scoped by transitivity.

#### [Q16] `/diff` viewer source-of-truth (DECIDED) {#q16-diff-source}

**Question:** Does the sheet read from the GIT feed, or fire a dedicated command?

**Resolution:** DECIDED → **Dedicated `git_diff_request` command, single-shot response.** The GIT feed is a separate consumer with its own lifecycle; the dev-card must own its `/diff` content rather than ride on a shared feed. The command and response shape are new; tugcast adds the request handler and a typed response. See [#d21-diff-dedicated-command] and [#step-10].

#### [Q17] `/context` HUD shape — gauge or popover (DECIDED) {#q17-context-hud-shape}

**Question:** Linear gauge in Z4, arc gauge as a chip, or popover-on-hover?

**Resolution:** DECIDED → **Reuse the arc gauge from the status-bar popover.** The status bar's existing arc-gauge component already looks great and renders the same shape of data (used/total). The `/context` HUD adopts the same arc-gauge atom. See [#d22-context-arc-gauge] and [#step-11].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| [R01] Z4B layout shift when chips populate / change | low | med | **Resolved by decision:** Z4B chips are NOT width-stabilized; the two-line agent chips reflow with their content, accepted by design | Reflow becomes visually disruptive in practice |
| [R02] `Shift+Tab` clashes with browser/IDE chord | med | low | Substrate responder consumes the event only when card is focused; bubbles otherwise | Bug report or focus-trap regression test fails |
| [R03] `/rewind` shape divergence from terminal | high | low | Capture probe in [#step-7a] before [#step-7] designs the sheet, per [D10]. The probe's findings ARE the spec | Drift between dev-card `/rewind` flow and terminal behavior surfaces |
| [R04] Claude 2.1.155+ reshapes `rate_limit_event` | low | med | Strict typing + capture-capabilities catches drift; doc warns the runbook | Drift regression FAILs on `rate_limit_event` shape |
| [R05] AskUserQuestion >4-option regression in dev-card surface | low | low | Reuse existing salvage path from Tide; renderer caps at 4 + Other | New AskUserQuestion call with 5+ options surfaces |
| [R06] Image-attach regression after Step-5c | med | low | Wire-shape pin tests exist (`replay-pending-row-injection.test.ts`); add a real-app `just app-test` case for drag-drop | Image probe test-23 starts failing |
| [R07] Effort has no live set verb; change needs a respawn ([#step-4]) | med | high | **Accepted (2026-05-30):** no `set_effort` control subtype in 2.1.158 (only `set_model`/`set_permission_mode`); set via `--effort` spawn flag ⇒ `effort_change` respawns claude with `--resume`. Transcript preserved via tugcast resume/replay; chip updates optimistically. Build as written — effort changes are infrequent and the reconnect is brief | A future claude adds a `set_effort` control verb (swap to a live request, no UI change); or the respawn reconnect proves disruptive |

**Risk R01: Z4B layout shift when chips populate / change** {#r01-z4b-layout-shift}

- **Risk:** Permission-mode, model, and rate-limit chips arrive at slightly different times and change content over the session (mode cycles, rate-limit ticks "5h" → "59m" → "rate-limited"). A chip whose width tracks its content reflows the Z4B cluster on each change.
- **Decision (resolves the risk):** Z4B chips are **not** width-stabilized. They render as two-line `TugBadge` (`label-top`, `size="sm"`, `role="agent"`) sized to their current content; the cluster reflows when content changes, and that is accepted. No `widthStabilize`, no reserved max-width slots, no hidden-alternate stacks. This matches the cutover already shipped for the existing Z4B chips (route / project / session).
- **Why accepted:** the chips sit in a centred indicator cluster flanked by flex spacers, so a width change re-centres rather than shoving fixed neighbours; the content changes are infrequent and user-driven (mode cycle) or slow (per-minute rate-limit tick). The complexity of cross-content reservation is not worth it here.
- **Residual risk:** a fast-changing value could make the cluster appear jittery. Trigger to revisit: reflow becomes visually disruptive in practice — at which point width-stabilization can be reintroduced per-chip without changing the two-line shape.

**Risk R03: `/rewind` shape divergence from terminal AND mount-identity loss on truncation** {#r03-rewind-divergence}

- **Risk (two parts):**
  - **Wire divergence:** Per [D10], the dev-card's `/rewind` must reproduce the same wire / state mutations as the terminal. If [#step-7a]'s empirical capture misses an edge case (e.g. how the terminal handles forking from a turn that's mid-thinking), the dev-card flow diverges.
  - **Mount-identity loss on truncation:** When the fork removes turns after `msg_id`, the transcript's remaining turns (those BEFORE `msg_id`) must keep their React reconciliation identity per [L26]. If the implementer remounts the transcript wholesale on truncation — by swapping the transcript-data-source reference, by using a phase-encoded list key, or by routing pre/post-fork rows through different cell renderers — the user loses scroll position, selection, and any in-flight DOM state in the surviving rows. This is the [L23] failure mode "internal ops never lose user-visible state."
- **Mitigation:**
  - [#step-7a]'s probe drives `/rewind` end-to-end in a real session and pins the canonical event sequence.
  - Re-run the probe after any tugcode / claude version bump that touches session-command handling.
  - Drift regression catches wire deviations between captures.
  - [#step-7]'s task list pins the three [L26] identity inputs (key, component type, renderer reference) verbatim; the L26 real-app pin in tests asserts scroll position and selection survive the fork.
- **Residual risk:** A future claude version may change `/rewind` behavior, requiring a re-capture and dev-card update — but the same is true for any terminal-modeled flow.

---

### Design Decisions {#design-decisions}

> Each decision is firm absent reviewer override.

#### [D01] Z4B is the chrome anchor for ambient session state (DECIDED) {#d01-z4b-chrome-anchor}

**Decision:** Permission-mode, model, rate-limit, and session-state chips all live in the Z4B prompt-indicator cluster (`dev-card.tsx:2391-2401`). All chips are display-only indicators per [D13].

**Rationale:**
- Z4B already exists; the placement-experiment harness already maps content into it.
- Bottom-of-prompt-entry placement preserves screen real estate for the transcript while keeping ambient state always-visible at the point of input.
- Adjacent chips share the same `useSyncExternalStore` source ([#d04-session-metadata-hub]), amortizing plumbing.

**Implications:**
- No new top-level dev-card slots required.
- **Canonical chip render:** every Z4B chip is a two-line `TugBadge` (`layout="label-top"`, `size="sm"`, `role="agent"` — escalating to `caution` on alert states like rate-limit / drift), **not** width-stabilized ([#r01-z4b-layout-shift]). The caption line is the field's name (`MODE`, `MODEL`, `LIMIT`, `SESSION`); the content line is the value.
- Z4B cluster order: `permission-mode | model | rate-limit | project-path | session-state`. Z3 stays for placement-experiment overrides per `dev-card.tsx:2400`.
- No chip-click affordance per [D13] — mutations go through slash commands or `Shift+Tab`.

#### [D02] `Shift+Tab` cycle matches the terminal exactly (DECIDED) {#d02-cycle-order}

**Decision:** The `Shift+Tab` cycle is 4-way: `default → acceptEdits → plan → auto → default`. `bypassPermissions` and `dontAsk` are reachable only via the badge popover, not via cycling.

**Rationale:**
- Preserves muscle memory for users migrating from the terminal.
- `bypassPermissions` is genuinely dangerous to cycle into accidentally; popover-only access is intentional friction.
- Matches Anthropic's stated UX for the cycle.

**Implications:**
- Substrate responder enforces 4-mode set.
- Popover lists all 6 modes for explicit selection.
- The badge popover is the only graphical surface for the 5th and 6th modes (matches `/permissions`).

#### [D03] Mode-change mutations round-trip via tugcode (DECIDED) {#d03-roundtrip-mutations}

**Decision:** Chip state updates from the post-mutation `system_metadata` refresh, not from the keypress directly. The dev-card sends `{type: "permission_mode", mode: "<name>"}` and waits for the next `system_metadata` to confirm.

**Rationale:**
- Keeps the badge truthful even if a mode change races a concurrent turn.
- Single source of truth: `SessionMetadataStore.getSnapshot().permissionMode`.
- Matches the model-change pattern already in place.

**Implications:**
- Brief flicker as the round-trip completes — acceptable, typical < 50 ms.
- An optimistic-update mode could be added later if the flicker is too noticeable; not in scope.

**Revised in [#step-1] follow-up — there is no round-trip for `permission_mode`.** Empirically (Step 1), claude answers `set_permission_mode` with a `control_response` only; it does NOT emit a fresh `system_metadata`. Neither does `model_change`. So waiting for a metadata refresh would leave the chip stuck. The dev card instead updates **optimistically**: `SessionMetadataStore.applyPermissionMode(mode)` writes the new mode into the snapshot the moment the frame is sent (matching the terminal's optimistic banner). It self-corrects — the next authoritative `system_metadata` (on respawn / re-init) replaces the snapshot wholesale, carrying the same mode tugcode applied (tugcode owns `permissionMode` via `--permission-mode` + `permissionManager`). The "truthful even under a racing turn" goal still holds: tugcode is the single authority and the optimistic value equals what it forwards.

#### [D04] `SessionMetadataStore` is the data hub for Phase A (DECIDED) {#d04-session-metadata-hub}

**Decision:** All four Z4B chips read from `SessionMetadataStore` via `useSyncExternalStore`. Rate-limit info extends `SessionMetadataSnapshot` per [#q02-rate-limit-store]'s recommendation.

**Rationale:**
- Single store, single subscription pattern, single set of [L02] tests.
- Adjacent chip rerender churn is acceptable — the snapshot only changes on `system_metadata` events (~once per turn).

**Implications:**
- `SessionMetadataSnapshot` grows a `rateLimit: RateLimitInfo | null` field.
- The `SessionMetadataFeed` proposed in [session-metadata-feed.md](session-metadata-feed.md) becomes the snapshot-feed source; without it, Z4B chips show transient `"…"` until first turn.

#### [D05] The session chooser is for `/resume`; `/rewind` gets its own sheet (REVISED) {#d05-session-picker-sheet}

> **Revised 2026-05-30 (post-[#step-7a]).** The original decision had `/rewind`, `/resume`, and future pickers share one generic `SessionPickerSheet`. The [#step-7a] empirical work proved `/rewind` and `/resume` are **different operations with different data and different actions** — lumping them was a category error. This decision is narrowed accordingly. (The generic primitive was also never separately built — see [#step-6]: the capability lives in `dev-picker-cells.tsx`.)

**Decision:** The **session chooser** (`dev-picker-cells.tsx` `session-resume` rows; overlay per [D15]) serves **`/resume`** and any future *distinct-session* pickers — a list of separate conversations, picking one to bind. **`/rewind` does NOT use it**: it needs a **`RewindSheet`** with a fundamentally different data display (a list of *turns within the current session*, each with a per-turn code diff stat and a `(current)` marker) plus a **restore-options confirm form** (Restore code and conversation / Restore conversation / Never mind). Both mount as card-scoped overlays per [D15] (resolves [#q10-pane-sheet-anchor]).

**Rationale:**
- `/resume` = "switch which conversation this card is bound to" (sessions). `/rewind` = "move this conversation backward" (turns). Different list contents, different row annotations, different primary actions (bind vs. multi-dimension restore).
- Forcing them into one component would mean a data source AND an action model so divergent that the "shared" part is just "an overlay with a list" — not worth a shared abstraction.
- Overlay pattern keeps the dev-card's primary layout intact ([D15]).

**Implications:**
- `/resume` ([#step-8]) presents a focused sessions overlay (reusing the `SessionResumeCell` renderer + sessions data source via `cardPickerSheet`) — *not* the full-card `DevProjectPicker`. `/rewind` ([#step-7]) builds a dedicated `RewindSheet`. Both are `cardPickerSheet` overlays.
- The `/model` and effort pickers already ship as their own confirm-style sheets ([#step-1c]/[#step-4]) — not chooser consumers either.
- The horizontal split-pane in `dev-card.tsx:2425` stays reserved for its existing top-pane / bottom-pane layout — NOT used for sheet hosting.

#### [D06] v2.1.154 is the protocol baseline (DECIDED) {#d06-protocol-baseline}

**Decision:** Every event-shape reference in this plan resolves against `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.154/`. The drift regression must stay clean across the work.

**Rationale:**
- Anchors implementation against an empirically-verified shape.
- New event types this plan reads (`rate_limit_event`, `compact_boundary`) are present in v2.1.154 fixtures.
- A future version bump triggers the version-bump runbook ([fixtures README](../tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/README.md)) before this plan's consumers can drift.

**Implications:**
- Any step that adds a new IPC event-shape reader pins it via a fixture-derived test.
- A protocol regression caught by drift between steps blocks the next step until reconciled.

#### [D07] Per-card permission-mode persistence (DECIDED) {#d07-per-card-mode-persistence}

**Decision:** Permission mode is per-card and persists across card relaunches via tugbank `dev.permission-mode.<cardId>` (resolves [#q01-mode-persistence]).

**Rationale:**
- The terminal resets because terminals are stateless; the dev-card isn't.
- Card identity is stable across relaunch (the ledger restore matches on it).
- Aligns with the broader dev-card-per-card-state pattern (split-pane sash position uses the same key shape).

**Implications:**
- A freshly relaunched card carries forward its prior mode.
- A `permission_mode` IPC mutation persists at the card scope; the next mode flip writes through tugbank.
- The terminal-parity user experience is "mostly the terminal, but stickier when you come back."

#### [D09] Model-change confirmation in transcript (DECIDED) {#d09-model-confirm-in-transcript}

**Decision:** Synthetic `assistant_text` confirmations from `model_change` render in the transcript exactly as the terminal does (resolves [#q03-model-confirm]). No banner alternative.

**Rationale:**
- Matches the terminal's audit-trail behavior.
- The terminal's "Set model to claude-sonnet-4-6" line is informational and historically welcome — model changes are deliberate user actions worth pinning in scrollback.

**Implications:**
- No suppression in the transcript renderer.
- No banner component needed.
- [#step-2] task list does NOT include banner work.

#### [D10] `/rewind` matches the Claude Code terminal empirically (DECIDED) {#d10-rewind-matches-terminal}

**Decision:** The `/rewind` flow is designed by first observing what Claude Code's terminal does on the wire — what events claude/the harness emit, what state mutates, what session is created — and then matching the dev-card's IPC and UI to reproduce the exact same mutations (resolves [#q04-rewind-protocol]).

**Rationale:**
- Eliminates protocol-design speculation; the source of truth is the existing terminal behavior.
- Avoids accidentally diverging semantics (e.g. "fork-from" vs "truncate-and-resume" vs "client-side replay") from what users already know.
- The capture-capabilities probe harness is the right tool for this empirical study.

**Implications:**
- A new capture probe (`test-N-slash-rewind`) drives `/rewind` end-to-end in a real-claude session and pins the canonical event sequence in the golden catalog.
- [#step-7] gains a prerequisite empirical step that runs the probe before sheet design.
- The eventual dev-card IPC matches whatever shape the probe reveals — could be `session_command` extension, a new inbound type, or a client-driven replay. We do not pre-commit.

#### [D11] `/btw` uses the exclude-from-history flag (DECIDED) {#d11-btw-exclude-flag}

**Decision:** Out-of-history turns set `metadata.exclude_from_history: true` on the `user_message`. Claude 2.1.154 support is investigated as a sub-step; if absent, tugbank carries the exclusion via journal-side filtering (resolves [#q05-btw-shape]).

**Rationale:**
- Preserves the "doesn't pollute history" intent users expect from `/btw`.
- Tugbank-side filtering is a known-good fallback even if claude doesn't honor the flag.
- Minimal additional shape; one optional field on user_message.

**Implications:**
- Pre-implementation probe in [#step-13] confirms claude support.
- Tugbank journal reader respects the flag whether or not claude does.
- Transcript renderer hides `exclude_from_history: true` rows under a "show side questions" toggle (out of scope as a feature; the rows are absent by default).

#### [D13] Z4B chips are INDICATORS, not pickers (DECIDED) {#d13-z4b-indicator-only}

**Decision:** Every Z4B chip is purely an indicator displaying current state. Z4B chips do NOT open pickers or popovers on click. Mode changes go through `Shift+Tab` (cycle) or the `/permissions` slash command. Model changes go through the `/model` slash command, which opens its own picker sheet. Resolves [#q08-model-scope] by reshaping the question.

**Rationale:**
- Keeps the chrome small and visually consistent — chips show state; commands change state.
- Reduces accidental modal stacking from misclicked chips.
- Slash commands are the canonical user-action surface; reinforces that pattern.

**Implications:**
- [#step-1] permission-mode badge has NO click-to-popover affordance.
- [#step-2] model badge has NO click-to-picker affordance.
- A new step is required: `/model` slash command opens the model picker (was previously baked into Step 2).
- `/permissions` slash command's badge popover behavior is replaced with the slash-command-only entry point.

#### [D14] Slash popup excludes unsupported commands (DECIDED) {#d14-slash-unsupported-list}

**Decision:** The slash popup shows only commands with a working graphical surface. Unsupported commands are hidden. The canonical list of unsupported commands lives in a docs file (`tuglaws/dev-card-unsupported-slash-commands.md` or in this plan's [#documentation-plan]). Resolves [#q09-slash-popup-filter].

**Rationale:**
- Hiding is cleaner than greying-out for muscle-memory consistency.
- The doc list keeps the policy discoverable for users wondering "why isn't `/vim` here?"

**Implications:**
- The completion-merge seam and the submit-time dispatch this filter plugs into land in [#step-1c] (per [D23]); [#step-13] adds the allowlist *filter* over claude's reported commands + the discoverable doc.
- `SessionMetadataStore.getCommandCompletionProvider()` applies the allowlist before returning completions; the local-command registry from [#step-1c] is merged in alongside.
- The allowlist source is a single constant co-located with / read by the [#step-1c] registry; the docs reference the same constant.
- Typed `/vim` (etc.) is never sent to claude; it shows a brief *"Command not available"* notice ([#step-13a] refined the original "silent drop" — silently vanishing read as a bug since the user typed a real command). Local commands ([D23]) dispatch to their surface; a genuine unknown (`/foo`) shows an *"Unknown command"* notice; everything else (`/commit` and other claude-owned commands) is sent to claude verbatim.

#### [D15] Pane sheets are card-scoped overlays, not split-pane right halves (DECIDED) {#d15-pane-sheets-are-overlays}

**Decision:** All pane sheets (`/rewind`, `/resume`, `/permissions` rules editor, `/diff`, `/memory`, `/agents`, `/hooks`, `/help`) mount as **card-scoped overlays** — they cover only the card's content region, dim only within the card, and trap focus only within the card. They do NOT escape the card to cover the deck, the viewport, or other panes. The horizontal split-pane in `dev-card.tsx:2425` stays reserved for its existing top-pane / bottom-pane layout. Resolves [#q10-pane-sheet-anchor], modifies [#d05-session-picker-sheet].

**Rationale:**
- Keeps the dev-card's primary layout (transcript on top, prompt on bottom) intact.
- Overlays allow richer animation and a clearer "modal in front of work" mental model.
- Avoids tangling pane-sash logic with sheet lifecycle.
- **Card-scoping respects [L09]** — the card never sets position / size / z-order outside its own boundary. A sheet that portals to `body` or to a deck-level layer would be the card reaching into Pane geometry, which the Pane owns.

**Implications:**
- [#step-6] `SessionPickerSheet` mounts within the card root (e.g. `position: absolute` against a card-relative ancestor), NOT via a `body`-portal and NOT as a fixed-position viewport overlay.
- The dimming backdrop fills the card's content region; the rest of the deck (other panes, title bar, etc.) is unaffected.
- The split-pane in `dev-card.tsx:2425` keeps its current top/bottom semantics.
- Overlay close-button + ESC + clicking on the backdrop within the card all dismiss; focus restores to the prompt entry.
- Multi-card decks: opening a sheet in card A does not dim or affect card B.

#### [D16] `/clear` supported; `/help` is a tabbed sheet (DECIDED) {#d16-clear-help-supported}

**Decision:** `/clear` is supported and maps to the existing transcript-clear / new-session affordance. `/help` opens a tabbed sheet with content modeled on what the Claude Code terminal's `/help` offers — categorized command list, key shortcuts, links to docs (resolves [#q11-drop-list]).

**Rationale:**
- `/clear` is a high-value muscle-memory command users will type.
- `/help` as a tabbed sheet is a richer presentation than the terminal can offer and is straightforward to scaffold.

**Implications:**
- [#step-13] adds `/clear` → transcript-clear, `/help` → tabbed sheet.
- New file `help-tabbed-sheet.tsx` in [#symbol-inventory].
- `/quit` not included; close-card is the affordance.

#### [D18] `RateLimitEvent` strict-typed (DECIDED) {#d18-rate-limit-strict-shape}

**Decision:** Tugcode's `RateLimitEvent` IPC translation stays strict-typed per commit `9af307fe`. New fields claude adds are dropped silently (forward-compat); shape drift is caught by the capture-capabilities runbook (resolves [#q13-rate-limit-strictness]).

**Rationale:**
- Strict types are a quality gate.
- The drift regression catches removed-field drift before it lands in production.

**Implications:**
- No type changes to `tugcode/src/types.ts:RateLimitInfo` in this plan.
- A future claude shape change triggers the version-bump runbook; no in-plan accommodation.

#### [D19] `unknown_event` IPC frame added (DECIDED) {#d19-unknown-event-frame}

**Decision:** `routeTopLevelEvent`'s default branch (`tugcode/src/session.ts:1031`) emits an `unknown_event` IPC frame instead of silently dropping (resolves [#q14-unknown-event-ipc]). Frame carries `original_type` and a hex preview of the payload.

**Rationale:**
- Forward-compat catch-all without modifying the consumer schema.
- Frontend can surface a soft banner so users know when claude has emitted something this version doesn't understand.

**Implications:**
- New `UnknownEvent` IPC type in `tugcode/src/types.ts`.
- New banner component on the frontend ([#step-22]).
- The default-branch console log stays for operator visibility.

#### [D20] One card per session (DECIDED) {#d20-one-card-per-session}

**Decision:** Session-to-card binding is strictly 1:1. Two dev-cards cannot connect to the same tugcode session (resolves [#q15-multi-card-session] by recognizing the structural impossibility).

**Rationale:**
- The tugcode session manager owns a single stdin/stdout pipe to claude; two cards would race on it.
- Card lifecycle and session lifecycle are co-owned; multi-card-same-session would require disentangling them.

**Implications:**
- No work needed to coordinate multi-card sessions — the system enforces 1:1.
- `/rewind`'s "fork-and-card" action ([#step-7]) creates a NEW session for the new card; it does not bind the new card to the existing session.

#### [D21] `/diff` fires a dedicated `git_diff_request` command (DECIDED) {#d21-diff-dedicated-command}

**Decision:** The `/diff` sheet fires a dedicated `git_diff_request` command to tugcast and receives a single-shot typed response. The sheet does NOT read from the GIT feed (resolves [#q16-diff-source]).

**Rationale:**
- The GIT feed is a separate consumer with its own lifecycle; the dev-card must own its `/diff` content rather than ride on a shared feed.
- A single-shot request matches the sheet's lifecycle (open → fetch → display → close); the feed's continuous-update semantics aren't needed here.

**Implications:**
- New `git_diff_request` and `git_diff_response` types in the tugcast control protocol.
- Tugcast handler reads `git diff` from the project root and serializes the response.
- [#step-10] adds the tugcast side alongside the dev-card sheet.

#### [D22] `/context` HUD reuses the status-bar arc gauge (DECIDED) {#d22-context-arc-gauge}

**Decision:** The persistent context-usage HUD reuses the arc-gauge atom from the status-bar popover (resolves [#q17-context-hud-shape]).

**Rationale:**
- The arc gauge already exists, already renders the right shape of data, and already has battle-tested visual polish.
- Consistent atom across HUD and status-bar means consistent affordance.

**Implications:**
- [#step-11] mounts the existing `tug-arc-gauge.tsx` atom in Z4.
- No new gauge primitive needed.
- The expand-on-`/context` interaction shows the status-bar popover content directly (or a copy of it).

#### [D23] Local slash commands dispatch through the responder chain (DECIDED) {#d23-slash-dispatch}

**Decision:** Locally-handled slash commands are recognized at submit time against a single registry (`tugdeck/src/lib/slash-commands.ts`) and dispatched as a `RUN_SLASH_COMMAND` action through the responder chain ([L11]) to the dev-card's card-content responder, which opens the command's graphical surface. They are NOT sent to claude. The same registry is the completion source for local-only commands and the allowlist [D14] reads.

**Rationale:**
- One mechanism for every terminal-rendered-locally command (#l01-slash-cmd-inventory); each new command is a registry entry + a surface, not bespoke "popup routing."
- Key-card-scoped dispatch is the exact path the existing `CYCLE_PERMISSION_MODE` shortcut travels ([L11]); the card-content responder already owns the card's command surface, so it is the natural handler — no new side channel and no responder re-parenting.
- Registry-as-source-of-truth unifies completion, dispatch, and the [D14] allowlist.

**Implications:**
- The prompt entry dispatches `RUN_SLASH_COMMAND` **key-card-scoped** (`sendToKeyCard`, the same walk `CYCLE_PERMISSION_MODE` uses), so it lands on the card-content responder directly. No responder `parentId` pinning; the targeted-control-dispatch path (which would route through the settings-form responder and was fragile) is explicitly not used.
- Skip-send is gated on the dispatch's `handled` result — a matched command that no responder handles (gallery, handler-less host) falls through to a normal send rather than being swallowed.
- The local-command completion entries merge at the **dev-card composition layer** (where the `/` provider is already assembled), keeping `SessionMetadataStore` generic and the gallery popup clean.
- The action payload carries `{ name, args }` from the start, so arg-bearing commands (`/btw <text>`, `/add-dir <path>`) need no reshape.
- **Known ceiling (C):** the prompt entry imports one *global* matcher. This is correct while the dev card is the only card type with local commands (a non-dev host has no `RUN_SLASH_COMMAND` handler, so its dispatch falls through to send). If a *second* command-bearing card type ever shares `TugPromptEntry`, the global matcher could match a command that card cannot handle and the presence-based `handled` would swallow it. Migration path is cheap and local: inject the matcher per host (a small prop), leaving dispatch unchanged. Documented now so it is a deliberate boundary, not a surprise.
- [#step-2b] / [#step-7] / [#step-8] / [#step-9] / [#step-10] / [#step-12] drop "Modified: slash-command popup routing"; they register their command and provide its surface.
- [#step-13] / [D14] reduces to the unsupported-command allowlist filter + doc + the remaining UI-affordance mappings (`/help`, `/clear`, …).
- Built in [#step-1c], before any other command step consumes it.

#### [D24] Rate-limit is an app-level caution banner, not a Z4B chip (DECIDED) {#d24-rate-limit-banner}

**Decision:** Subscription-quota state is surfaced as a single **app-level, transient caution banner** (modeled on the reconnection banner / `TugBannerProvider`), shown only when claude signals trouble — NOT as a persistent per-card Z4B chip. This reverses the [#step-3] chip and supersedes [Q02]/[D04] for this surface (the per-card store hub was premised on the chip). See [#step-3.5].

**Rationale:**
- **Parity, not extension.** The Claude Code terminal exposes no usage/limit chrome and no `/usage`-style slash command; the documented place to check quota is the web console. A persistent dev-card indicator is an extension beyond parity. The terminal's only quota affordance is a *transient* "approaching/at your limit" notice — which a banner matches and a chip does not.
- **Quota is account-global.** One subscription quota is shared by every session/card. A per-card surface duplicates the identical state across cards; a single app-level banner is the correct cardinality. This is the same shape as the connection-disconnect banner, which is also one-per-app.
- **The data is coarse and unverified.** `rate_limit_event` carries no usage percentage and, in every captured sample, only the benign `allowed` / `overageStatus: "rejected"` default. A loud persistent chip over-promises on thin, guessed data; a transient banner that only appears on a non-`allowed` status (or active overage) and auto-clears fails safe.

**Implications:**
- The transport built in [#step-3] is retained and reused: tugcast `rate_limit_event` → SESSION_METADATA routing, and `protocol.ts` `RateLimitInfo` / `RateLimitEvent`. Only the per-card chip + its `SessionMetadataStore.rateLimit` binding were removed.
- An app-level `RateLimitStore` singleton (not the per-card `SessionMetadataStore`) holds the account-global quota; the banner provider mounts once in `deck-manager.ts`.
- Trigger keys on the `status` enum confirmed from the CLI `v2.1.158` zod schema (`allowed` | `allowed_warning` | `rejected`); `overageStatus` alone never escalates. `caution` for `allowed_warning` (approaching), `danger` for `rejected` (the genuine hard-limit — requests are refused, so error-grade is correct here, unlike the reverted chip which painted red off the benign `overageStatus` default).

---

### Deep Dives (Optional) {#deep-dives}

#### Slash Command Inventory {#slash-cmd-inventory}

**List L01: Claude Code slash commands — treatment in dev-card** {#l01-slash-cmd-inventory}

| Command | Terminal behavior | Bucket | Treatment | Step |
|---|---|---|---|---|
| `/cost` | Skill-backed, formatted cost table | 1 | Already works as skill turn; also surface as HUD ([#step-11]) | — |
| `/compact` | Skill-backed, compaction | 1 | Already works; `compact_boundary` divider in [#step-21] | — |
| `/commit`, `/review`, `/security-review`, `/code-review`, `/init`, `/clear` (skill) | Skill-backed | 1 | Already works | — |
| `/deep-research`, `/run-skill-generator`, `/loop`, `/schedule`, `/batch`, `/debug`, `/simplify`, `/verify`, `/run` | Skill-backed | 1 | Already works | — |
| `/claude-api`, `/fewer-permission-prompts`, `/update-config` | Skill-backed | 1 | Already works | — |
| `/tugplug:dash`, `/tugplug:plan`, `/tugplug:implement`, `/tugplug:merge` | Tugplug orchestrator skills | 1 | Already works with correct `--plugin-dir` | — |
| `/rewind` | Pick a checkpoint to fork from | 2 | **Overlay pane sheet**, terminal-empirically-modeled ([#d10-rewind-matches-terminal]) | 7 |
| `/resume` | Pick a prior session | 2 | **Overlay pane sheet** ([#step-8]) | 8 |
| `/status` | Print model/cwd/mode/session | 2 | **Already in Z4B chrome** via [#step-1]-[#step-4]; typed `/status` no-op (chrome is the surface) | 4 |
| `/model` | Interactive model picker | 2 | **Model picker sheet** ([#step-2b]); dispatched via the [#step-1c] registry — Z4B chip is indicator-only per [#d13-z4b-indicator-only] | 1c, 2b |
| `/permissions` | Tool-permission **rules** editor (allow/ask/deny/workspace) | 2 | **Rules editor sheet** ([#step-1-6]), empirically specced by [#step-1-5], dispatched via the [#step-1c] registry. **Distinct from the permission *mode*** (default/acceptEdits/plan/auto), which is the Z4B chip + `Shift+Tab` ([#step-1]) and has no slash command. | 1c, 1.5, 1.6 |
| `/diff` | `git diff` in pager | 2 | **Diff sheet** — `TugAccordion` (one item per file: path + `+N −M`, body renders hunks) over `git_diff_request` command ([#d21-diff-dedicated-command], [#step-10]) | 10 |
| `/context` | One-shot context snapshot | 2 | **Persistent HUD** reusing status-bar arc gauge ([#d22-context-arc-gauge]) | 11 |
| `/memory` | List/edit memory files | 2 | **Sheet** ([#step-12]) | 12 |
| `/agents` | List/edit agents | 2 | **Sheet** ([#step-12]) | 12 |
| `/mcp` | List MCP servers + auth | OUT | **Out of scope** ([#q06-mcp-auth-ownership]) — hidden from popup, no sheet | — |
| `/hooks` | List active hooks | 2 | **Sheet** ([#step-12]) | 12 |
| `/clear` | Clear transcript / new session | 2 | **Maps to existing transcript-clear** ([#d16-clear-help-supported]) | 13 |
| `/help` | Command help | 2 | **Tabbed sheet** modeled on terminal `/help` ([#d16-clear-help-supported]) | 13 |
| `/quit` | Quit | UNSUPPORTED | **Hidden** — close-card is the affordance | — |
| `/export` | Save conversation | 2 | **Save dialog** | 13 |
| `/copy` | Copy last response | 2 | **Inline button + Cmd+Shift+C** | 13 |
| `/btw` | Out-of-history side question | 2 | **Exclude-from-history flag** per [#d11-btw-exclude-flag] | 13 |
| `/add-dir` | Add working root | 2 | **Directory picker dialog** | 13 |
| `/bug` | File a bug report | UNSUPPORTED | **Hidden from popup** ([#step-13a]) — files feedback to Anthropic; no meaning over the bridge | 13.A |
| `/login`, `/logout` | Auth | UNSUPPORTED | **Host-app surface** — hidden from popup | — |
| `/vim`, `/theme`, `/color` | Terminal-only UI flags | UNSUPPORTED | **Hidden from popup** ([#d14-slash-unsupported-list]) | 13 |
| `/usage`, `/goal`, `/team-onboarding`, `/usage-credits`, `/extra-usage`, `/heapdump`, `/reload-skills` | Subscription/admin/dev | UNSUPPORTED | **Hidden from popup; case-by-case external link in docs** | — |

> **Correction (audit, below):** `/insights` was previously filed here as UNSUPPORTED. It is a `type:"prompt"` command (a pass-through that runs a real model turn), so it works for free when sent verbatim — it does NOT belong in the hidden set. See [#slash-cmd-audit].

#### Slash-Command Full-Inventory Audit (v2.1.158) {#slash-cmd-audit}

The `/help` output of Claude Code `2.1.158` lists ~60 commands — more than L01 enumerated. This audit dispositions **every** one, grounded in the command **`type`** each carries in the CLI binary (the authoritative classifier). It answers the two questions that matter for our bridge: *which are free pass-throughs, and which need client-side work in Tug.*

**The classifier (read from the CLI binary).** Every Claude Code command declares a `type`:

- **`type:"prompt"`** (19 commands) — the command **expands to a prompt and is submitted to the model**. Over our stream-json bridge this is a **pure pass-through**: send the `/command` text verbatim, claude runs a real turn, events stream back. **Zero Tug work** — [D23] already routes any non-local command to claude verbatim. The only requirement is that the slash-popup allowlist not *hide* them.
- **`type:"local"`** (29) — a synchronous JS handler runs in the CLI process; **no model turn, no rendered component**. A few are backend-effecting over stream-json (`/compact`, `/clear`); most are TUI/process-local (`/version`, `/fast`, `/rename`, `/reload-*`). Client-side: needs a Tug action or is N/A.
- **`type:"local-jsx"`** (74) — renders an **Ink/React component in the terminal**; purely TUI-bound. Over a headless/stream-json bridge it produces nothing. Client-side: needs a **Tug surface** (sheet / dialog / chip) to have any analog, or is deferred.

**Principle:** `prompt` ⇒ pass-through (free, just don't hide it). `local`/`local-jsx` ⇒ client-side (build a surface, or explicitly defer). This is the single rule that sorts the whole list.

**Refinement to [D14] (slash-popup allowlist).** [D14] hides "commands with no graphical surface." That is too blunt: a `prompt`-type command has no *surface* but has *real behavior*. The allowlist must therefore admit **three** visible classes — (1) skill-backed + `prompt`-type **pass-throughs** (visible, dispatched to claude); (2) **local commands with a Tug surface** ([D23] registry); (3) everything else **hidden**. The [#step-13] allowlist constant gains a "pass-through" tier keyed on the `slash_commands` catalog's reported type where available, defaulting to "send to claude" for unknown `/names` rather than swallowing them.

**List L02: full disposition** {#l02-slash-cmd-audit}

Legend — **✅ covered** (existing step) · **🆓 pass-through** (free this pass; ensure visible) · **🔧 cheap client win** (small surface; fold into an existing step this pass) · **⏸ defer** (out of this pass, reason given).

| Command | `type` | Class | Disposition |
|---|---|---|---|
| `/init` | prompt | pass-through | 🆓 runs a real turn (writes CLAUDE.md via tools) — works verbatim |
| `/insights` | prompt | pass-through | 🆓 model-generated report turn — works verbatim (un-hide; was mis-filed) |
| `/compact` | local | pass-through* | 🆓 backend-effecting; emits `compact_boundary` (divider in [#step-21]) |
| `/recap` | local | pass-through* | ⏸ low value; a one-line model recap — defer (no surface needed if ever wanted) |
| `/agents`,`/memory`,`/hooks` | local-jsx | client | ✅ [#step-12] listing sheets |
| `/permissions` | local-jsx | client | ✅ [#step-9] rules editor |
| `/diff` | local-jsx | client | ✅ [#step-10] diff sheet |
| `/context` | local | client | ✅ [#step-11] HUD |
| `/rewind`,`/resume` | local-jsx | client | ✅ [#step-7]/[#step-8] overlay sheets |
| `/model`,`/effort` | local(+jsx) | client | ✅ [#step-2b]/[#step-4] chips + pickers |
| `/help`,`/clear`,`/btw` | local(-jsx) | client | ✅ [#step-13] |
| `/status` | local-jsx | client | ✅ covered by Z4B chrome ([#step-1]–[#step-4]); typed `/status` is a no-op |
| `/export`,`/add-dir` | local-jsx | client | ✅ planned in [#step-13] (save dialog / dir picker) |
| `/skills` | local-jsx | client | ✅ **promoted to [#step-12]** — read-only listing alongside agents/hooks/memory |
| `/rename` | local | client | ✅ **promoted to [#step-13]** — names the **session** (ledger `name` column + `rename_session` verb); surfaced in the Z4B session chip (≤16 chars) and the session chooser; no IPC to claude |
| `/fast` | local | client | ⏸ defer — Opus fast-mode toggle; a model-variant control, revisit with the model chip |
| `/branch` | local-jsx | client | ⏸ defer — conversation branching; Phase B session-fork follow-on (sibling of `/rewind`) |
| `/plan` | local-jsx | client | ⏸ defer — plan-mode workflow is an explicit [#non-goals] follow-on |
| `/goal` | local(-jsx) | client | ⏸ defer — agentic "work until condition met" loop; significant standalone feature |
| `/focus` | local-jsx | client | ⏸ defer — transcript view filter (a view preference, not parity-critical) |
| `/config` | local-jsx | client | ⏸ defer — settings UI is the Tug.app host's, per [#non-goals] |
| `/loop`,`/tasks`,`/autofix-pr` | local(-jsx) | client | ⏸ defer — automation / background-task / PR orchestration; out of conversational-parity scope |
| `/advisor`,`/reload-plugins`,`/reload-skills`,`/plugin` | local(-jsx) | client | ⏸ defer — plugin/advisor/dev-loop config; host or future plan |
| `/login`,`/logout`,`/privacy-settings` | local-jsx | client | ⏸ defer — auth / account; Tug.app host surface |
| `/ide`,`/desktop`,`/mobile`,`/remote-control`,`/remote-env`,`/background` | local(-jsx) | client | ⏸ defer — cross-app / device / teleport / terminal-freeing; not the dev-card's concern |
| `/doctor`,`/release-notes` | local-jsx | client | ⏸ defer — install diagnostics / info display; low parity value |
| `/ultraplan`,`/ultrareview` | web | n/a | ⏸ defer — Claude Code **on the web**; user-triggered cloud, cannot be launched from the card ([#non-goals]) |

\* `/compact` and `/recap` are `type:"local"` but produce a *backend* effect over stream-json (compaction / a generated line) rather than a pure TUI render — so they behave as pass-throughs when sent verbatim, unlike the other `local` commands.

**Recommended additions to the current parity pass** (everything else above is either already covered or deferred):

1. **Pass-throughs — no build, just don't hide them.** `/init`, `/insights`, `/compact` (and, structurally, *every* `prompt`-type and skill command). Action: the [#step-13] allowlist must keep these visible and route them to claude verbatim per the [D14] refinement above. Verify each emits a normal turn over the bridge with a one-shot probe before relying on it (the `type:"prompt"` expansion is expected to work headless, but confirm — same empirical discipline as [D10]).
2. **Two wins promoted into existing steps:** `/skills` → a read-only listing in [#step-12] (same shape as agents/hooks/memory — genuinely cheap); `/rename` → a **session-name** feature in [#step-13], surfaced in the Z4B session chip (≤16 chars) and the session chooser. `/rename` grew from "trivial" to a small **cross-layer** feature (ledger `name` column + `rename_session` verb + chip + chooser reads) once it became a real, persisted session label rather than a card-tab rename — still contained, scoped accordingly in the step.

**Explicitly deferred this pass** (with the grouped reasons in L02): conversation-structure (`/branch`, `/plan`, `/goal`), view/preference (`/focus`, `/fast`, `/config`), automation (`/loop`, `/tasks`, `/autofix-pr`, `/recap`), plugin/dev-loop (`/advisor`, `/plugin`, `/reload-*`), account/host (`/login`, `/logout`, `/privacy-settings`, `/ide`, `/desktop`, `/mobile`, `/remote-control`, `/remote-env`, `/background`, `/doctor`, `/release-notes`), and web-only (`/ultraplan`, `/ultrareview`). None are conversational-surface parity gaps; each is a host-app, account, automation, or web concern with a natural future home.

**SKIP set (already deferred by the user) — confirmed out of scope.** `/chrome`, `/color`, `/copy`†, `/exit`, `/feedback`, `/install-github-app`, `/install-slack-app`, `/keybindings`, `/mcp`, `/passes`, `/powerup`, `/radio`, `/sandbox`, `/stickers`, `/teleport`, `/terminal-setup`, `/theme`, `/tui`. All are `local`/`local-jsx` terminal-UI flags, account/novelty, install/host, or MCP (already [#q06-mcp-auth-ownership] out). They stay hidden from the popup per [D14].
† `/copy` is already independently planned in L01 ([#step-13], inline copy button); it is in the user's SKIP list as a *command* but the capability is covered by the transcript's copy affordance — no slash entry needed.

#### Z4B chrome cluster layout {#z4b-chrome-layout}

Z4B cluster, left-to-right when all chips are populated. **All chips are display-only indicators ([#d13-z4b-indicator-only]).** No click-to-popover, no click-to-picker.

```
[permission-mode] [model] [rate-limit?] [project-path] [session-state]
```

- `permission-mode`: two-line `label-top` chip, width tracks the current mode label (not width-stabilized per [R01]). Display-only. Mode changes via `Shift+Tab` or `/permissions`.
- `model`: format `Opus 4.8 · 1M`. Display-only. Model changes via `/model` slash command.
- `rate-limit`: appears only when `status !== "allowed"` or `resetsAt < 60min`; otherwise absent (removed, no placeholder slot). Display-only.
- `project-path`: existing chip, already cut over to the two-line `label-top` / `size="sm"` / `role="agent"` config (caption `PROJECT`).
- `session-state`: existing chip, already cut over to the same two-line config (caption `SESSION`). Shows the session **name** when one has been set via `/rename` ([#step-13]) — capped at ~16 chars, ellipsized, with the full name + raw id in the tooltip — falling back to the truncated `tugSessionId` otherwise. (The original lifecycle-state refinement was cancelled; lifecycle lives in the status bar — see [#step-4].)

#### `/rewind` interaction flow {#rewind-flow}

**Spec S01: `/rewind` interaction flow** {#s01-rewind-flow}

*Re-specced 2026-05-30 against the [#step-7a] empirical capture — two steps, two restore dimensions. The terminal screenshots are the spec.*

1. User types `/rewind` in prompt entry, or invokes via slash popup. `RewindSheet` mounts as a card-scoped overlay ([D15]).
2. **Picker step.** Lists the *current session's* user messages (turns), most-recent first — **not** a session list ([D05] retired for `/rewind`). Each row: timestamp, preview (first ~100 chars of `userText`), and a **code diff-stat badge** (`+N −M`, or "No code changes") sourced from a `rewind_files{dry_run:true}` per turn; `(current)` marks the live tip. Arrow keys / mouse to select.
3. **Confirm step.** Picking a turn opens a confirm sheet — "Restore the code and/or conversation to the point before this message" — with **three** actions **conditional on `canRewind`** for that turn:
   - `Restore code and conversation` — only when the turn has a surviving checkpoint (`canRewind:true`).
   - `Restore conversation` — always.
   - `Never mind` — cancel back to the picker (or dismiss).
   - (The terminal also offers `Summarize from here` / `Summarize up to here`. Those are **deferred / out of scope** — no wire verb for scoped compaction; see [#step-7]. The dev-card omits these rows rather than shipping them disabled.)
4. **Apply.** The chosen action sends `{type:"session_rewind", promptUuid, scope, fork}` (`promptUuid` = claude's user-prompt-record uuid, the anchor — [#step-7]):
   - `scope:"code"|"both"` → tugcode issues `rewind_files{dry_run:false, user_message_id:promptUuid}` (reverts files claude edited via Edit/Write).
   - `scope:"conversation"|"both"` → tugcode truncates the session JSONL at the `promptUuid` record and silent-respawns (`--fork-session` by default — "the conversation will be forked", card rebinds to the fork; `--resume` in place is the destructive opt-in). The UI truncates its transcript locally; the respawn does not re-emit it ([#step-7-2]/[#step-7-3]).
5. ESC at either step dismisses without action.
6. **Reachability limit:** a turn whose checkpoint aged out (`canRewind:false`) still offers conversation restore; code restore is shown unavailable, not hidden.
7. Empty-state: a 0- or 1-turn session does not surface `/rewind` in the slash popup.

---

### Specification {#specification}

#### Inputs and Outputs {#inputs-outputs}

**Inbound IPC types added in this plan:**

- `rewind_preview` (Phase B, [#step-7-1]) — `{type:"rewind_preview", promptUuid}`. Tugcode issues `rewind_files{dry_run:true, user_message_id:promptUuid}` and relays `rewind_preview_result` `{promptUuid, canRewind, filesChanged?, insertions?, deletions?}` (the picker's per-turn diff stats).
- `session_rewind` (Phase B, [#step-7-1]/[#step-7-2]) — `{type:"session_rewind", promptUuid, scope:"conversation"|"code"|"both", fork?:boolean}`. `code`/`both` → `rewind_files{dry_run:false}` control request; `conversation`/`both` → truncate the session JSONL at the `promptUuid` record + silent respawn (`--resume`, or `--fork-session` when `fork`). **`promptUuid` is claude's user-prompt-record uuid**, surfaced additively as a new optional field on the `user_message` frame ([#step-7], anchor design) — *not* the dev-card's `msgId`.
- `user_message` frame gains an optional `promptUuid?` ([#step-7-1]) — claude's prompt-record uuid, captured from the user-echo event. Additive; does not change `msgId`/`turnKey`.
- `effort_change` ([#step-4]) — `{type: "effort_change", effort: string}`. Tugcode respawns claude with `--effort <level>` + `--resume` (no live `set_effort` control verb exists in 2.1.158, per [R07]).

**Outbound IPC types added in this plan:**

- `unknown_event` (optional per [#q14-unknown-event-ipc]) — `{type: "unknown_event", original_type: string, payload_hex_preview: string, ipc_version: number}`. Default-branch catch-all for forward-compat.

**Existing IPC types this plan consumes (no changes):**

- Outbound: `system_metadata`, `rate_limit_event`, `assistant_text`, `tool_use`, `tool_result`, `tool_use_structured`, `control_request_forward`, `api_retry`, `cost_update`, `turn_complete`, `compact_boundary`.
- Inbound: `permission_mode`, `model_change`, `session_command`, `tool_approval`, `question_answer`, `interrupt`, `user_message`.

#### Modes / Policies {#modes-policies}

- Permission modes cycle (per [#d02-cycle-order]): `default → acceptEdits → plan → auto → default`. `bypassPermissions` and `dontAsk` reachable only via badge popover.
- Rate-limit chip visibility (per [#step-3] / [#q02-rate-limit-store]): **revised after observing real wire data** — every captured `rate_limit_event` is the benign `status: "allowed"`, `overageStatus: "rejected"` (org-disabled) default, and the payload carries no "percent used". Show the chip ONLY when `status !== "allowed"` OR `isUsingOverage`; the near-reset heuristic and the `overageStatus === "rejected"` → danger rule are removed (they lit a red chip on healthy idle sessions). Calm `caution` (amber) when visible; no `danger`/red tier until a confirmed hard-limit payload is captured.
- Slash-popup filter (per [#q09-slash-popup-filter]): graphical-supported allowlist; dev-flag shows full list.

#### Semantics {#semantics}

- All Z4B chip data flows from `SessionMetadataStore.getSnapshot()` via `useSyncExternalStore` (L02-compliant).
- Mutations (permission mode, model) round-trip via tugcode ([#d03-roundtrip-mutations]); chip updates from post-mutation `system_metadata`.
- `/resume` reuses the session chooser (`dev-picker-cells.tsx`); `/rewind` uses its own `RewindSheet`. They are **not** one parameterized component — different data (sessions vs. turns) AND different actions (bind vs. multi-dimension restore) ([D05], [#step-7a]). What they share is only the card-scoped overlay shell (open/close, focus-trap, ESC/backdrop dismiss).
- Pane sheets close on ESC and on clicking the card-scoped backdrop ([D15]).
- Tick-driven displays (rate-limit banner countdown, api_retry banner countdown) use [L22] direct-DOM mutation for the tick text — never `useSyncExternalStore` for the per-second value. See [#step-3.5] and [#step-16].

#### State zone mapping {#state-zones}

> Per [L24], every piece of state belongs to exactly one zone. The mechanism follows the zone. This table maps every new state slot in this plan to its zone so the implementer doesn't choose the wrong mechanism by default.

**Table T01: State zone for each new field** {#t01-state-zones}

| Component / field | Zone | Mechanism | Notes / law citations |
|---|---|---|---|
| `TugBadge` — `layout` + `label` props | Local data | Component props | Pure-function rendering; no internal state |
| `TugBadge` — label-line typography (uppercase, tracked) | Appearance | CSS rules in `tug-badge.css` reading shared label-typography tokens | [L06]; visual vocabulary shared with status-bar legend via `--tug7-element-field-text-normal-label-rest` token, NOT by reaching into TugBox's slot per [L20] |
| `TugBadge` — two-line intra-chip sizing (width = wider of the two rows) | Appearance | CSS inline-flex column intrinsic sizing | [L06]; this is the chip sizing to its own content, NOT cross-content reservation — Z4B chips are not width-stabilized per [R01] |
| `PermissionModeChip` — current mode label | Structure | `useSyncExternalStore(SessionMetadataStore)` | [L02]; reads `permissionMode` |
| `PermissionModeChip` — hover / focus / active visuals | Appearance | CSS via `data-state` attribute | [L06]; no React state for visuals |
| `PermissionModeChip` — persisted mode for restore | Structure | tugbank `dev.permission-mode.<cardId>` | [D07]; written by Shift+Tab handler, read on card mount |
| `Shift+Tab` substrate responder registration | Structure | `useLayoutEffect` at card mount | [L03]; per `feedback_substrate_responder` memory |
| `Shift+Tab` cycle-next computation | Local data | Pure function of current mode | No state owned by the handler |
| `ModelChip` — current model label | Structure | `useSyncExternalStore(SessionMetadataStore)` | [L02]; reads `model` |
| `ModelChip` — hover / focus visuals | Appearance | CSS | [L06] |
| `RateLimitChip` — structural state (`status`, `resetsAt`, `isUsingOverage`) | Structure | `useSyncExternalStore(SessionMetadataStore)` | [L02]; triggers React commit on shape change |
| `RateLimitChip` — visibility predicate result | Local data | Derived from structural state via memo | Pure derivation |
| `RateLimitChip` — color / overage indication | Appearance | CSS via `data-status` / `data-overage` attributes | [L06]; no React state |
| `RateLimitChip` — countdown text per tick | Appearance via store→DOM | `useLayoutEffect` + `setInterval` writes `textContent` directly | [L22]; structural data drives shell, DOM mutation drives tick |
| `SessionMetadataSnapshot.rateLimit` | Structure | Extension of `SessionMetadataStore` | [D04], [Q02]; single source of truth |
| Overlay sheet (session chooser / `RewindSheet`) — open/closed | Local data | `useState` in card | Sheet is card-local, no cross-card coordination |
| Overlay sheet — current selection index | Local data | `useState` in sheet | Internal navigation state |
| Overlay sheet — scroll position on dismiss | Structure | tugbank `dev.<sheet>.<cardId>.<sheetKind>` | [L23]; survives card relaunch |
| Overlay sheet — backdrop / focus-trap visuals | Appearance | CSS within card root, scoped per [D15] | [L06], [L09] |
| `RewindSheet` — turn-row projection | Structure | Pure projection over `code-session-store.transcript` | Source-of-truth lives in code-session-store; rows carry claude's `user_message` uuid + diff-stat |
| `RewindSheet` — per-turn diff-stat (`+N −M` / canRewind) | Structure | `rewind_preview_result` (from `rewind_files{dry_run}` via tugcode) | [#step-7]; populated async per row |
| `RewindSheet` — chosen restore scope (code/conversation/both) | Local data | `useState` in confirm step | Drives the `session_rewind` inbound |
| Transcript row mount identity across `/rewind` fork | Structure (mount invariant) | Stable key + component type + renderer ref | [L26]; pinned in [#step-7] |
| `ModelPickerSheet` — selected model index | Local data | `useState` in sheet | Internal navigation state |
| `PermissionRulesEditor` — draft rule list | Local data | `useState` in editor | Each rule commit is atomic; no draft-vs-commit (not L08 mutation tx) |
| `PermissionRulesEditor` — backdrop visuals | Appearance | CSS within card root | [L06], [D15] |
| `DiffSheet` — fetched diff payload | Local data | `useState` in sheet, populated by `git_diff_request` response | Single-shot per [D21]; not a continuous feed |
| `DiffSheet` — file list scroll / hunk fold state | Appearance + Local data | CSS for fold visuals; local state for fold toggle map | [L06] for visuals; local for which-files-folded |
| `ContextHud` — current usage / context_window | Structure | `useSyncExternalStore(CodeSessionStore)` reading `cost_update.usage` | [L02] |
| `ContextHud` — arc-gauge fill | Appearance | CSS variable bound to derived ratio | [L06], [D22]; gauge visual driven by `--tug-gauge-ratio` |
| `MemorySheet` / `AgentsSheet` / `HooksSheet` — list data | Structure | `useSyncExternalStore(SessionMetadataStore)` for the source arrays | [L02], [D04] |
| `HelpTabbedSheet` — current tab | Local data | `useState` in sheet | Internal navigation state |
| `HelpTabbedSheet` — command list source | Structure | `SessionMetadataStore.slashCommands` filtered through allowlist | [L02], [D14] |
| `ToolApprovalModal` — current `control_request_forward` payload | Structure | `useSyncExternalStore` of pending-request store | [L02]; modal mounts on arrival, dismisses on response |
| `ToolApprovalModal` — input-preview expand/collapse | Appearance + Local data | CSS for visuals; `useState` for collapsed flag | [L06]; expand is a single-shot UX state |
| `ApiRetryIndicator` — structural state (attempt, max, error) | Structure | `useSyncExternalStore` of api_retry store | [L02] |
| `ApiRetryIndicator` — countdown text per tick | Appearance via store→DOM | `useLayoutEffect` + `setInterval` writes `textContent` directly | [L22]; same pattern as RateLimitChip |
| Thinking collapsible — expand/collapse | Appearance + Local data | CSS for visuals; `useState` for expanded flag | [L06] |
| `@`-file completion — popup open / selection | Local data | `useState` in completion provider | Existing completion infrastructure |
| `@`-file completion — file list source | Structure | FILESYSTEM snapshot feed (0x10) | [L02] |
| Image-attachment thumbnail strip — pending attachments | Local data | `useState` in prompt entry | Cleared on send |
| Image-attachment downsample / encode | Local data | Pure async pipeline; result attached to send | Existing `image-downsample.ts` |
| Interrupt-intent per-turn flag | Structure | Stored on active turn record in code-session-store | [L23]; survives until `turn_complete` |
| `CompactBoundaryDivider` — render | Structure | Driven by `compact_boundary` event presence in transcript | Stateless from divider's POV |
| `UnknownEventBanner` — current unknown events | Structure | `useSyncExternalStore` of unknown-event store | [L02]; dismissible per banner |
| `UnknownEventBanner` — dismissed event IDs | Local data | In-memory set; reset on card relaunch | Not worth persisting |

**Rule of thumb if a field is absent from the table:** structural data that drives renderable visuals is `useSyncExternalStore`; data that drives DOM mutations only is store-observer + direct DOM (per [L22]); data scoped to a single component instance that no other code reads is `useState`; anything that's pure visual feedback to a gesture is CSS via attribute toggles.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|---|---|
| `tugdeck/src/components/tugways/tug-badge.tsx` | **Modified** — adds `layout?: "single" \| "label-top" \| "content-top"` and `label?: string` props per [#step-0] / Spec S02 |
| `tugdeck/src/components/tugways/tug-badge.css` | **Modified** — new layout rules + label typography borrowed from `tug-box.css` legend/label-above style |
| `tugdeck/src/components/tugways/cards/gallery-badge.tsx` | **Modified** — gallery card sections demonstrating all three layouts ([#step-0]) |
| `tugdeck/src/components/tugways/cards/gallery-badge.css` | **Modified** — gallery layout for the new sections |
| `tugdeck/src/components/tugways/cards/permission-mode-chip.tsx` | Z4B permission-mode indicator chip ([#step-1]) — display-only per [D13]; rendered via `TugBadge` `label-top` / `size="sm"` / `role="agent"` per [#step-0], not width-stabilized per [R01]. Compositional component: `.tsx`-only, no `.css` (composes `TugBadge`, adds no styling). |
| `tugdeck/src/lib/permission-mode.ts` | Pure cycle / label / parse helpers ([#step-1]) |
| `tugdeck/src/lib/use-permission-mode.ts` | Cycle callback + per-card tugbank persistence + mount-restore hook ([#step-1]) |
| `tugdeck/src/components/tugways/cards/model-chip.tsx` | Z4B model indicator chip ([#step-2]) — display-only per [D13] |
| `tugdeck/src/components/tugways/cards/model-picker-sheet.tsx` | `/model` picker overlay sheet ([#step-2b]) |
| `tugdeck/src/components/tugways/cards/effort-chip.tsx` | Z4B interactive effort chip ([#step-4]); model-gated |
| `tugdeck/src/components/tugways/cards/effort-picker-sheet.tsx` | Effort picker sheet + `useEffortPicker` ([#step-4]) |
| `tugdeck/src/lib/effort.ts` | Pure effort-level helpers (levels, label, parse) ([#step-4]) |
| `tugdeck/src/lib/rate-limit-store.ts` | App-level account-global quota store ([#step-3.5]) |
| `tugdeck/src/components/chrome/rate-limit-banner-bridge.tsx` | App-level rate-limit caution banner provider ([#step-3.5]) |
| `tugdeck/src/lib/rate-limit.ts` | Pure banner-state + countdown helpers ([#step-3.5]) |
| `tugdeck/src/components/tugways/cards/session-picker-sheet.tsx` | Reusable overlay session-picker primitive ([#step-6]) |
| `tugdeck/src/components/tugways/cards/session-picker-sheet.css` | Sheet layout (overlay) |
| `tugdeck/src/components/tugways/cards/rewind-turn-source.ts` | `/rewind` turn-row projection over `code-session-store.transcript` ([#step-7-3]) |
| `tugdeck/src/components/tugways/cards/resume-sheet-data-source.ts` | `/resume` data source over tugbank session journal ([#step-8]) |
| `tugdeck/src/components/tugways/cards/permission-rules-editor.tsx` | `/permissions` picker + rules editor sheet ([#step-9]) |
| `tugdeck/src/components/tugways/cards/diff-sheet.tsx` | `/diff` overlay sheet ([#step-10]) |
| _(no new file — `/context` reuses the status-row CONTEXT popover via `DevTelemetryStatusRowHandle`; [#step-11])_ | — |
| `tugdeck/src/components/tugways/cards/memory-sheet.tsx` | `/memory` listing; row-click opens the path in the OS editor/Finder via the host `openPath` handler ([#step-12a]) |
| `tugdeck/src/components/tugways/cards/agents-sheet.tsx` | `/agents` read-only Running + Library sections (sectioned TugListView) ([#step-12b]) |
| `tugdeck/src/components/tugways/cards/hooks-sheet.tsx` | `/hooks` read-only TugAccordion (event → matcher groups); request/response via `hooks-inventory.ts` ([#step-12c]) |
| `tugdeck/src/components/tugways/cards/skills-sheet.tsx` | `/skills` read-only listing with rich columns ([#step-12d]) |
| `tugdeck/src/components/tugways/cards/help-tabbed-sheet.tsx` | `/help` tabbed sheet ([#step-13]) per [D16] |
| `tugdeck/src/lib/slash-commands.ts` | `LOCAL_SLASH_COMMANDS` registry + `matchLocalSlashCommand` — the locally-handled-command dispatch source of truth ([#step-1c]) per [D23] |
| `tugdeck/src/lib/slash-supported.ts` | Canonical `GRAPHICAL_SUPPORTED_COMMANDS` allowlist per [D14] ([#step-13]; reads / co-located with `slash-commands.ts`) |
| `tugdeck/docs/dev-card-unsupported-slash-commands.md` | Discoverable list of unsupported commands per [D14] |
| `tugdeck/src/components/tugways/cards/tool-approval-modal.tsx` | `control_request_forward` (`is_question: false`) modal ([#step-15]) |
| `tugdeck/src/components/tugways/cards/dev-card-banner-spec.ts` | `api_retry` card banner case ([#step-16]) — reuses the card's `TugPaneBanner`, not a Z4B chip |
| `tugdeck/src/components/tugways/cards/at-file-completer.ts` | `@`-file completion provider ([#step-18]) |
| `tugdeck/src/components/tugways/cards/compact-boundary-divider.tsx` | Transcript divider on `compact_boundary` ([#step-21]) |
| `tugdeck/src/components/tugways/cards/unknown-event-banner.tsx` | Soft warn banner for `unknown_event` IPC frames per [D19] ([#step-22]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|---|---|---|---|
| `SessionMetadataSnapshot.rateLimit` | field | `tugdeck/src/lib/session-metadata-store.ts` | New optional field `RateLimitInfo \| null`; parsed from `rate_limit_event` payload per [D02→Q02] |
| `SessionMetadataStore._onRateLimitUpdate` | method | same | Reads the most-recent `rate_limit_event` |
| `UnknownEvent` | type | `tugcode/src/types.ts` | Added per [D19] — `{type:"unknown_event", original_type, payload_hex_preview, ipc_version}` |
| `routeTopLevelEvent` default branch | branch | `tugcode/src/session.ts:1031` | Emits `unknown_event` IPC frame per [D19] (in addition to existing console log) |
| `SHIFT_TAB_RESPONDER` | constant | `tugdeck/src/lib/substrate-responders.ts` (new or existing module) | Substrate responder for the Z4B cycle |
| `GRAPHICAL_SUPPORTED_COMMANDS` | constant | `tugdeck/src/lib/slash-supported.ts` | Per [D14] |
| `LOCAL_SLASH_COMMANDS` / `matchLocalSlashCommand` | constant + fn | `tugdeck/src/lib/slash-commands.ts` | Per [D23] / [#step-1c]; registry + exact-match lookup |
| `RUN_SLASH_COMMAND` | action | `tugdeck/src/components/tugways/action-vocabulary.ts` | Per [D23] / [#step-1c]; key-card-scoped dispatch from the prompt entry to the card-content responder; payload `{ name, args }` |
| `useKeyCardDispatch` | hook | `tugdeck/src/components/tugways/` | Per [#step-1c]; key-card-scoped dispatch of `RUN_SLASH_COMMAND` (the `CYCLE_PERMISSION_MODE` path) |
| local-command completion merge | wiring | `tugdeck/src/components/tugways/cards/dev-card.tsx` | Per [#step-1c]; composes the local-command provider into the `/` provider (`SessionMetadataStore` stays generic) |
| `useSessionMetadata.permissionMode` selector | hook | `tugdeck/src/components/tugways/cards/use-dev-card-observer.ts` | Wraps `useSyncExternalStore` |
| `RewindSheet` + `rewind-turn-source.ts` | component + projection | new files | `/rewind` turn picker + restore-options confirm form; *turns-in-this-session* data, **not** the session chooser ([D05] / [#step-7]). (The generic `SessionPickerSheet<TRow>` was retired — see [#step-6].) |
| Tugcast `git_diff_request` / `git_diff_response` | control protocol | tugcast control module | New typed request/response per [D21] for `/diff` |
| `/rewind` IPC types | inbound `rewind_preview{promptUuid}` + `session_rewind{promptUuid,scope,fork}`; outbound `rewind_preview_result`; `user_message` frame gains optional `promptUuid?` | `tugcode/src/types.ts` + tugdeck `protocol.ts` | Resolved empirically in [#step-7a]. Anchor = claude's prompt-record uuid (additive new field, not `msgId`). Code dim → `rewind_files` control request; conversation dim → JSONL truncate + silent `--resume` (no IPC to claude) |

---

### Documentation Plan {#documentation-plan}

- [x] Add a short design note to [tuglaws/component-authoring.md](../tuglaws/component-authoring.md) (or a small standalone doc) documenting the `TugBadge` two-line layout per [#step-0] / Spec S02 — when to use `label-top` vs `content-top` vs `single`. (Landed as the "Two-line label / content layout (TugBadge)" subsection under Component Patterns.)
- [x] Update [transport-exploration.md](transport-exploration.md) "Terminal-Only Features" section to mark resolved rows with their dev-card landing-step and add the empirical `/rewind` findings from [#step-7a] (the `#rewind-files-control-request` section + the input-surface / conversation-rewind findings).
- [ ] Author `tugdeck/docs/dev-card-unsupported-slash-commands.md` per [D14] — every command the popup hides, with a brief reason. Linked from the slash popup's "?" help affordance and from `/help`.
- [x] Update [transport-exploration.md](transport-exploration.md) with the empirical `/rewind` shape: `rewind_files` is the only wire verb (code dim); conversation dim is JSONL-truncate + `--resume`; documented in `#rewind-files-control-request`.
- [ ] Add a Z4B chrome diagram to [tuglaws/pane-model.md](../tuglaws/pane-model.md) — Z4B was undocumented as a chrome surface; this plan makes it canonical. Annotate chips as indicator-only per [D13].
- [ ] If the card-scoped overlay-sheet shell (used by both the session chooser and `RewindSheet`) is worth codifying, add an overlay-sheet pattern note to [tuglaws/component-authoring.md](../tuglaws/component-authoring.md) per [D15] (the shared part is the shell, not a data/action primitive — [D05]).
- [ ] Update the dev-card chrome docstring in `dev-card.tsx` near `Z4B — prompt-entry indicator slot` comment to reference the chip-cluster order and the indicator-only policy.
- [ ] Document the tugcast `git_diff_request` / `git_diff_response` control commands in the tugcast control-protocol docs.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|---|---|---|
| **Pure-logic (`bun:test`)** | Reducer transitions, store updates, type guards, completion-provider behavior | All non-DOM logic; per `feedback_no_happy_dom_tests`, no jsdom |
| **Real-app (`just app-test`)** | End-to-end mount, focus, keyboard, badge text-content verification | Per `feedback_just_app_test`; every chrome chip and pane sheet gets at least one |
| **Probe / real-claude** | Round-trip behavior against live claude | When a new inbound IPC type is added (e.g. `session_rewind`); when control_request_forward UI lands |
| **Drift regression** | Pin the stream-json contract | Run after each step that touches event-shape reading; `just capture-capabilities` after `tugcode` IPC changes |

#### What stays out of tests {#test-exclusions}

- Mock-store unit tests of stores (per `feedback_no_mock_store_tests`) — use real `SessionMetadataStore` against fixture payloads instead.
- jsdom RTL tests (per `feedback_no_happy_dom_tests`).
- Time-budget assertions (per `feedback_no_time_budgets`).

---

### Execution Steps {#execution-steps}

> Every step has explicit `**Depends on:**` and `**References:**` lines. Phase A is [#step-0] through [#step-5] (Step 0 is the TugBadge two-line spike that all Z4B chips depend on; [#step-1c] is the local slash-command dispatch foundation that lands `/permissions` and that every later command step builds on); Phase B is [#step-6] through [#step-14] (includes [#step-2b] `/model` picker and [#step-7a] empirical capture); Phase C is [#step-15] through [#step-22]; the final integration checkpoint is [#step-23].

#### Step Status Ledger {#step-status-ledger}

> **The march checklist (audited 2026-05-30).** Verified against the codebase (artifacts + app-tests + commits), not just the checkboxes. `✅ DONE` = shipped, skip it; `▶ TODO` = remaining work; `⛔ SUPERSEDED` = reverted/cancelled, do not build; `⚠ VERIFY` = open question (see flags below the table). The remaining march, in order, is the `▶`/`⚠` rows.

| Step | Title | Status | Evidence / note |
|---|---|---|---|
| 0 | TugBadge two-line spike | ✅ DONE | `tug-badge.tsx` `layout`/`label`; `at0087` |
| 1 | Permission-mode chip + `Shift+Tab` | ✅ DONE | `permission-mode-chip.tsx`; `at0088` |
| 1c | Local slash-command dispatch | ✅ DONE | `lib/slash-commands.ts`; completion merge |
| 1.5 | Capture `/permissions` read/write | ✅ DONE | prereq consumed by 1.6 |
| 1.6 | `/permissions` rules editor | ✅ DONE | `permission-rules-editor.tsx`; `at0090`–`at0094` |
| 2 | Model chip | ✅ DONE | `model-chip.tsx` |
| 2a / 2a.1 / 2a.2 / 2a.3 | `initialize` handshake + capabilities replay | ✅ DONE | `capabilities.ts`, `session_capabilities`; commits `8254f037`…`33cd3ad7` |
| 2b | `/model` picker | ✅ DONE | `model-picker-sheet.tsx`; `ebc21271` |
| 3 | Rate-limit **chip** | ⛔ SUPERSEDED | reverted `9abb96bc` → banner ([#step-3.5], [D24]) |
| 3.5 | Rate-limit **banner** | ✅ DONE | `rate-limit-banner-bridge.tsx`; `1c264064` |
| 4 | Effort chip | ✅ DONE | `effort-chip.tsx` + `effort-picker-sheet.tsx` + `lib/effort.ts` + `use-effort.ts`; tugcode `--effort`/`effort_change` respawn ([R07]); `at0096` PASS |
| 5 | Phase A integration checkpoint | ✅ DONE | verified by running the live app (full Z4B cluster); per-capability app-tests `at0087`/`at0088`/`at0095`/`at0096` |
| 6 | `SessionPickerSheet` primitive | ✅ DONE | capability exists via `dev-picker-cells.tsx` (session-resume rows, kbd nav, overlay); generic primitive not separately needed |
| 7a | Capture terminal `/rewind` | ✅ DONE | full empirical reverse-engineering vs `claude 2.1.158`. 4 mechanisms verified live: diff-stats + code restore via `rewind_files` control verb; conversation restore via JSONL-truncate + `--resume`; cancel. Summarize = in-process compaction, **no wire verb → deferred**. `test-36-slash-rewind` pinned; catalog re-baselined to v2.1.158 |
| 7b.1 | `/rewind`: `rewind_files` bridge (tugcode) | ✅ DONE | `rewind_files` control relay + `rewind_preview`/diff-stats + code restore; idle-gated; live through-tugcode probe `test-37` (golden `b1e4c122`); `rewind-bridge.test.ts` |
| 7b.2 | `/rewind`: conversation rewind (tugcode) | ✅ DONE | `session_rewind{scope:conversation/both}` → JSONL truncate + fork/`--resume`; compaction-boundary guard; live probes `test-38`/`test-39`; empty-first-turn guard `290927d5` |
| 7b.3 | `/rewind`: `RewindSheet` (tugdeck) | ✅ DONE | `rewind-turn-source.ts` + `RewindSheet` (single wide step, lazy diff-stat, idle/empty-state gating, fork-default, history rewind); L26-safe local truncation; `at0097`/`at0098` |
| 8 | `/resume` | ✅ DONE | focused sessions overlay `resume-sheet.tsx` via `cardPickerSheet` (reuses `SESSIONS_CELL_RENDERERS` + sessions data source); cancel keeps the live session; `at0099` |
| 9 | `/permissions` picker + editor | ✅ DONE | folded into 1.6 (`permission-rules-editor.tsx`) — Q-B |
| 10.A | `/diff` sourcing — tugcast `git_diff_request` | ✅ DONE | tugcast handler + protocol + round-trip proof |
| 10.B | `/diff` accordion sheet (dev-card UI) | ✅ DONE | `diff-sheet.tsx` over the 10.A feed |
| 11 | `/context` → status-bar popover | ✅ DONE | typed `/context` pops the existing CONTEXT popover via `DevTelemetryStatusRow` imperative handle; no HUD/sheet |
| 12.D | `/skills` read-only list | ✅ DONE | `skills-sheet.tsx` + `skills-inventory-store.ts` + tugcode `skills-inventory.ts`; request/response through tugcode (zero-Rust); rebuild tugcode to exercise live |
| 12.B | `/agents` Running + Library | ✅ DONE | `agents-sheet.tsx` + `agents-list.ts`; Running from transcript (pending Task), Library = built-in roster + plugin/user; sectioned TugListView, no tugcode |
| 12.A | `/memory` list → OS editor | ✅ DONE | `memory-sheet.tsx` + `memory-destinations.ts` + `os-open.ts` + host `openPath` handler (NSWorkspace); rebuild host to exercise live |
| 12.C | `/hooks` read-only accordion | ✅ DONE | `hooks-sheet.tsx` + `hooks-inventory-store.ts` + tugcode `hooks-inventory.ts`; request/response, merges settings.json scopes; rebuild tugcode to exercise live |
| 13.A | Slash-popup filtering + unsupported doc | ✅ DONE | `slash-supported.ts` three-tier classifier (`SUPPORTED_LOCAL` derived from registry + explicit `HIDDEN_SLASH_COMMANDS`); `filterCommandProvider` at dev-card composition layer (popup alphabetized via `mergeCommandProviders` sort); typed `/command` the card won't run → `SHOW_SLASH_COMMAND_NOTICE` → `presentAlertSheet` with reason `unsupported` (hidden) or `unknown` (typo, catalog-aware `isUnknownRemoteCommand`); `tuglaws/dev-card-unsupported-slash-commands.md` (`/bug` hidden) |
| 13.B.1.A | `TugPaneBulletin` primitive + gallery card | ✅ DONE | thin Sonner wrapper scoped per pane via `toasterId` (`<Toaster id={useId()}>` + `toast(...,{toasterId})`); `position: fixed→absolute` containment in a relative+isolated root; `gallery-pane-bulletin.tsx`. Sonner owns stacking/hover/removal — no reinvention. L06/L14/L17/L19 |
| 13.B.1.B | `/copy` adoption | ✅ DONE | `lastAssistantCopyText` selector + `/copy` handler → green `TugPaneBulletin` "Most recent message copied" above Z2; provider wraps header+transcript (`overflow:hidden`, no scrollbar). Cmd+Shift+C NOT bound (taken by `SELECT_ROUTE`) — slash-only |
| 13.B.2 | `/help` sheet | ✅ DONE | two-tab `TugSheet` (General: shortcuts + unsupported-doc link; Commands: built-in list). `projectHelpCommands` (`help-content.ts`): `local`-category, hidden filtered, help-text-required; skills/agents left to popup + `/agents`. Custom tab dropped by decision. Non-interactive `TugListView`; `permission-rules-editor` tab idiom |
| 13.B.3 | `/clear` (mini spike → implement) | ✅ DONE | `/clear` = fresh session in card (reuse spawn path); old subprocess closed, stays resumable. Core fix: `cardServicesStore._reconcile` now rebuilds on `tugSessionId` change (also repairs latent `/resume`-different + resume-"New session" gap). `sendCloseSessionKeepingBinding`; no picker flash |
| 13.C | Host/IPC bridge: `/export` `/add-dir` | ✅ DONE | `/export`: `transcript-export.ts` (md+jsonl) → `os-export.ts` → new `exportSession` `NSSavePanel` host bridge w/ Format popup. `/add-dir`: reuse `choosePath` `NSOpenPanel` → real `add_directory` CODE_INPUT verb (claude rejects `/add-dir` headless) → tugcode respawns w/ `--add-dir`+`--resume` (mirrors effort; no Rust change). Swift `BUILD SUCCEEDED`; tugcode recompiled; needs `just app-debug` to take effect |
| 13.C.1 | `tugproto` shared verb contract + registry | ✅ DONE | Inbound wire-verb contract authored once in source-only `tugproto/` (`@tugproto/*` alias; resolves in tugcode bun-compile, tugdeck tsc/vite). `isInboundMessage` derived from `INBOUND_VERBS` (allowlist footgun gone); `INBOUND_HANDLERS` registry replaces the 16-way `if/else`. Unions had drifted → shared with sender-permissive types + 2 one-line tugcode narrowings; guards kept (a test uses them); protocol_init/user_message stay special. Suites 555 + 3275 green |
| 13.D | `/rename` cross-layer session name | ✅ DONE | tugcast ledger `name TEXT` (self-healing) + `rename(...)` + `rename_session` CONTROL verb (broadcasts `session_updated`); tugdeck `encodeRenameSession`, arg+bare-dialog surface, `session-name`/`session-name-store`, Z4B chip name (≤16, tooltip=name+id), chooser row-title. Name seeded into chip on rename/list/restore. Suites 3281 + 691 green; needs `just app-debug` (tugcast no HMR) |
| 13.E | `/btw` exclude-from-history | ⏸ DEFERRED | Paused by user decision (a more powerful idea pending). Probe DONE (Path B — claude 2.1.159 strips the flag, marker persists in JSONL); design pivoted to a one-shot side-question aside, prototype-first. Nothing built; resumes from 13.E.0 |
| 14 | Phase B integration checkpoint | ✅ CLOSED | Waived as ceremony — every Phase B sub-step verified live + checkpointed as it landed; `/btw` item N/A while 13.E deferred |
| 15 | `control_request_forward` approval UI | ✅ DONE | `PermissionDialog` (`dev-permission-dialog`) handles tool approval — Q-C |
| 16 | `api_retry` banner | ✅ DONE | tugdeck-only (forwarding/type already existed). Pure `classifyApiRetry` (every category → label + transient/likely-fatal severity) + `formatRetryCountdown`; `apiRetry` snapshot state (`deadline` stamped in the impure wrapper), cleared on `cost_update`/`turn_complete`; `kind:"api-retry"` banner spec under hard-error, over transport; DOM-ticked countdown ([L22]); `TugPaneBanner.message` widened to ReactNode. tsc clean, 3296 pure tests green; `at0105` authored + passed warm (cold single-file run races the harness Vite-compile gate, not the code) |
| 17 | `thinking_text` empty-state | ✅ DONE | decision: **omit** ([Q12]) — no empty header to build — Q-D |
| 18 | `@`-file completion | ✅ DONE | `services.fileCompletionProvider` wired to prompt entry |
| 19 | Image drag/paste | ✅ DONE | `image-downsample.ts`, `atom-bytes-store.ts`, `synthesize-user-message.ts` |
| 20 | Interrupt visibility | ✅ DONE | `tug-prompt-entry.tsx` primary `Stop` button + `canInterrupt` |
| 21 | `compact_boundary` divider | ✅ DONE | Wire-check: the summary is NOT on the bridge (never sent live — client-dispatched `/compact`; deliberately skipped on replay; the terminal hides it too). Only the bare `compact_boundary` marker is reachable (live auto-compaction). Landed a **soft divider** (Q-E follow-up — user chose divider-only): tugcode forwards `compactMetadata` (trigger + pre_tokens); tugdeck accepts `compact_boundary`, `handleCompactBoundary` appends a `system_note{source:"compact"}` to the active turn, rendered as a CSS-only `─── Conversation compacted · ~Nk tokens ───` separator. tsc clean (tugdeck+tugcode), 3309 pure tests green; `at0106` authored |
| 21.A | `/compact` real compaction | ✅ DONE | Spike-proven mechanism, built **client-side** (no Rust/tugcode orchestration needed — the win of fresh-session-with-seed): `/compact [focus]` is now supported-local; the dev-card summarizes the current session, captures the summary, spawns a fresh session (the `/clear` path), and the `dev-session-restore` live-hook seeds it **suppressed** (summary → claude's context, not the transcript) + flags the divider. New reusable single-turn suppression in the reducer; `compactionSeed` snapshot flag drives a CSS-only divider header. Fixed the Step 21 `compact_metadata.pre_tokens` field bug. tsc clean (tugdeck+tugcode); 3318 pure tests green (prompt builder, suppression, mark-seed); `at0107` authored (divider + suppression — full continuity is spike-verified, not stub-testable). preTokens null for manual `/compact` (graceful "Conversation compacted") — enrichment is a follow-up |
| 22 | `unknown_event` IPC frame | ✅ DONE | tugcode default branch emits `unknown_event` {original_type, payload_hex_preview (first 64B JSON, hex), ipc_version:2} + keeps operator log (`payloadHexPreview` pure helper); tugdeck reads/normalizes → `snapshot.unknownEvent` (reducer-stamped `at`, survives turn boundary) → lowest-precedence dismissible soft warn banner (caution, names the type, own `unknownDismissedAt`). Added status-variant footer to `TugPaneBanner` + gallery demo. tsc clean; tugcode 205 + tugdeck 3346 pure tests; `at0108` PASS |
| 23 | Phase C integration checkpoint | ▶ TODO | verification only |

**Audit questions — resolved 2026-05-30:**

- **Q-A ([#step-8] `/resume`) → RESOLVED.** Reuse the existing session chooser **as-is** (it is the same UI); the only work is re-wiring *cancel* to leave the current session unchanged instead of closing the card. Step 8 rescoped accordingly.
- **Q-B ([#step-9]) → RESOLVED: already done.** Folded into [#step-1.6]'s `permission-rules-editor.tsx`. Step 9 marked DONE.
- **Q-C ([#step-15]) → RESOLVED: already done.** Tool approval ships as `PermissionDialog` (`dev-permission-dialog`). Step 15 marked DONE.
- **Q-D ([#step-17]) → RESOLVED: omit.** No empty thinking header ([Q12]); nothing to build. Step 17 marked DONE.
- **Q-E ([#step-21]) → RESOLVED: build it.** Nothing exists today; the terminal shows compact summary content, so render that same content the same way when available. The wire-check for what we actually receive is part of the step. Step 21 stays TODO, rescoped.

#### Step 0: TugBadge two-line presentation — design mini-spike {#step-0}

**Commit:** `feat(tugways): TugBadge two-line label/content layout + gallery card`

**References:** [D01] Z4B chrome anchor, [D13] Z4B indicator-only, Risk R01 Z4B layout shift, [L06] appearance via CSS/DOM, [L15] token-driven control states, [L19] component-authoring compliance, [L20] tokens scoped to component slot, (#z4b-chrome-layout, #context, #strategy)

**Problem statement.** Current Z4B already shows three single-line chips (`Claude Code 2.1.x`, `Project: <path>`, `Session: <id>`). This plan adds four more (`permission-mode`, `model`, `rate-limit`, `session-state`). Seven single-line pills will overflow a reasonably-narrow card. The status bar at the top of the dev-card uses a two-line presentation (`STATE` letter-spaced label over `Idle` content; same for `TIME`, `TOKENS`, `CONTEXT`, `TASKS`) that packs information without taking more horizontal space. Borrow that pattern for TugBadge so Z4B chips can present `LABEL` over `content` in the same band.

**Goal.** Land a TugBadge variant that supports two-line label/content presentation in both orderings, demo it in the gallery, and decide which ordering the dev-card chips will use — before any Z4B chip ([#step-1] through [#step-4]) consumes it.

**Artifacts:**
- Modified: `tugdeck/src/components/tugways/tug-badge.tsx` — new `layout` prop with three variants and new `label` prop separate from content
- Modified: `tugdeck/src/components/tugways/tug-badge.css` — new layout rules + label typography reusing the status-bar style (`text-transform: uppercase`, `letter-spacing: 0.08em`, weight 600, `--tug7-element-field-text-normal-label-rest` color) so the chip and the status-bar legend share a single visual vocabulary
- Modified: `tugdeck/src/components/tugways/cards/gallery-badge.tsx` + `gallery-badge.css` — new gallery card sections demonstrating both two-line orderings alongside the existing single-line layout
- New: short design note in [tuglaws/component-authoring.md](../tuglaws/component-authoring.md) (or a small follow-on doc) documenting the two-line shape and when to use which ordering

**Spec S02: TugBadge two-line presentation** {#s02-two-line-badge}

- Props additions:
  - `layout?: "single" | "label-top" | "content-top"` — default `"single"` (no breaking change to existing call sites).
  - `label?: string` — only meaningful when `layout !== "single"`; rendered as the letter-spaced uppercase line. Single-layout call sites continue passing only `children`.
- Layout rules:
  - `single`: existing pill, content is `children`.
  - `label-top`: two stacked rows; row 1 = `label` styled per [#s02-label-typography]; row 2 = `children` styled as existing content text.
  - `content-top`: same two rows in reverse vertical order.
- Intra-chip width: the badge's outer width is the max of the label-line and content-line widths (inline-flex column intrinsic sizing). This is the chip sizing to its own content only — there is no cross-content pre-allocation. Z4B chips are deliberately NOT width-stabilized across content changes per [#r01-z4b-layout-shift]; the consumer-side reservation pattern is demonstrated in the gallery as a reference but not used by the Z4B chrome.
- Height series: the two-line layouts take a fixed per-size height mirroring the `TugPushButton` height scale by value (`--tugx-badge-twoline-height-*`: 20/24/28/32/36 px for `2xs`→`lg`; 40/44 px for `xl`/`2xl`) so a chip reads as tall as a button. The `lg` face equals the dev-card submit button (`TugPushButton size="lg"`); Z4B chips use `lg`. Tokens are badge-scoped per [L20] — derived from, not borrowed from, TugButton.

**Spec S02-typography: label-line typography** {#s02-label-typography}

The label line borrows directly from the status-bar's existing legend / label-above style (already documented in `tug-box.css:74-91`):

- `font-weight: 600`
- `text-transform: uppercase`
- `letter-spacing: 0.08em`
- `color: var(--tug7-element-field-text-normal-label-rest)`
- size: one notch smaller than the content line — likely a new component-scoped token `--tugx-badge-label-text-size`

The visual vocabulary is intentionally shared with the status bar so a user reading either surface sees the same label discipline.

**Decision deferred to spike outcome:** which ordering (`label-top` vs `content-top`) the dev-card Z4B chips use. The screenshot's status bar uses `label-top`. The recommended starting point for Z4B is `label-top` for consistency, but the gallery card demonstrates both so the team can compare in context.

**Tasks:**
- [x] Audit existing TugBadge call sites (`grep` `TugBadge` across `tugdeck/src`) to ensure adding the `layout` and `label` props is non-breaking (they're optional with `"single"` default). Confirmed: all existing call sites omit `layout`/`label` and keep the `single` default; full `bun test` (3039 tests) stays green.
- [x] Add the `layout` + `label` props to `TugBadge`. Per-layout DOM structure: `single` renders as today; `label-top` and `content-top` render two `<span>`s in a vertical flex with column ordering driven by CSS (`column` vs `column-reverse`), not by reordered DOM children (caption is always DOM-first).
- [x] Borrow the status-bar legend typography per [#s02-label-typography]. Added component-scoped `--tugx-badge-label-text-size` (em-relative, one notch under content) and `--tugx-badge-label-tracking` under TugBadge's own slot per [L20] — TugBox's tokens are untouched.
- [x] Width-stabilize: the badge's effective width is the wider of the label line and content line (per [R01]) — an inline-flex column sizes its cross axis to the widest row, so the chip is as wide as its widest line with no fixed width. (Cross-*content* reservation is the consumer's job, demoed in the gallery.)
- [x] Height series derived from `TugPushButton`. Two-line chips take a fixed per-size height mirroring the button scale by value (`--tugx-badge-twoline-height-*`: 20/24/28/32/36 px for `2xs`→`lg`, extending to 40/44 px for `xl`/`2xl`) so a chip stands as tall as a button. The `lg` face = the dev-card submit button (`TugPushButton size="lg"`, 36 px); the gallery two-line demos and Z4B chips use `lg`. Tokens live in the badge's own slot ([L20] — derived from, not borrowed from, TugButton).
- [x] Confirm token sourcing: label color is `--tug7-element-field-text-normal-label-rest` (the shared field-label token) per [L18]; no new color tokens minted. `audit:tokens lint` passes.
- [x] Add gallery card sections demonstrating all three layouts side-by-side: `single` (current), `label-top`, `content-top`. Realistic Z4B content rows (`MODE / accept`, `MODEL / Opus 4.8 · 1M`, `LIMIT / 5h 23m`, `SESSION / 6d77f06e`) plus a width-stabilized rate-limit slot. **Note:** landed in the real, registered `GalleryBadge` showcase (`gallery-registrations.tsx`) — the `gallery-badge.tsx` named in the artifacts list is an orphaned, unregistered exploratory mockup that does not use the real `TugBadge`; demoing there would prove nothing.
- [x] Add a short design note to `tuglaws/component-authoring.md` ("Two-line label / content layout (TugBadge)") documenting when to use each layout: `single` for transient/single-fact pills; `label-top` for chrome that mirrors status-bar conventions; `content-top` for the rare value-first case.
- [~] Decide the Z4B chip ordering. **Recommendation: `label-top`** for status-bar visual parity. Final sign-off pending a by-hand gallery view (requires the macOS Accessibility grant on Tug.app — see Checkpoint).

**Tests:**
- [x] Existing single-layout call sites continue to pass (non-breaking) — full `bun test` suite green (3039 pass / 0 fail).
- [x] New-layout DOM shape (two children with the right class names, CSS-driven visual order) — covered by `at0087-tug-badge-two-line.test.ts` (real DOM; tugdeck has no DOM-rendering unit layer).
- [x] Real-app: `at0087` opens the badge gallery card and asserts both two-line layouts render with the borrowed caption typography (uppercase, weight 600, non-zero tracking) and the correct visual stacking order.
- [x] Real-app: `at0087` confirms width-stabilization — toggles the rate-limit value between "5h 23m" and "rate-limited" in a `label-top` slot and asserts the reserved slot width does not move.

**Checkpoint:**
- [x] `cd tugdeck && bun test` — 3039 pass / 0 fail.
- [~] `just app-test tug-badge-two-line` — test written and reaches `launchTugApp`; blocked on the one-time macOS Accessibility grant for `dev.tugtool.app.debug` (System Settings → Privacy & Security → Accessibility). Re-run after granting.
- [ ] Open the badge gallery card by hand; sign off on the chosen Z4B chip ordering (recommended `label-top`) before Step 1 starts consuming it.

**What this step does NOT do:**
- Does not mount any Z4B chip — that's [#step-1] through [#step-4].
- Does not change the existing single-line TugBadge default behavior — every existing call site keeps working without modification.
- Does not touch the status bar — only borrows its typography. The status bar's existing TugBox-driven layout is unchanged.

---

#### Step 1: Permission-mode indicator + `Shift+Tab` cycle in Z4B {#step-1}

**Depends on:** #step-0

**Commit:** `feat(dev-card): permission-mode indicator in Z4B with shift+tab cycle`

**References:** [D01] Z4B chrome anchor (canonical chip render), [D02] cycle order matches terminal, [D03] round-trip via tugcode, [D04] SessionMetadataStore data hub, [D07] per-card mode persistence, [D13] Z4B indicator-only, Risk R01 (no width-stabilization), Risk R02, (#z4b-chrome-layout, #constraints, #strategy)

**Artifacts (as built):**
- New: `tugdeck/src/components/tugways/cards/permission-mode-chip.tsx` — display-only chip. **No `.css`**: it composes `TugBadge` and adds no styling, so per the component-authoring "Compositional Component" rule it is `.tsx`-only (deviation from the artifact list's `permission-mode-chip.css`).
- New: `tugdeck/src/lib/permission-mode.ts` — pure helpers (`PERMISSION_MODE_CYCLE`, `cyclePermissionMode`, `formatPermissionMode`, `parsePersistedPermissionMode`, `PERMISSION_MODE_DOMAIN`).
- New: `tugdeck/src/lib/use-permission-mode.ts` — the cycle callback + per-card persistence (`writePersistedPermissionMode`, mirroring `diff-view-pref.ts`) + mount-restore effect.
- New: `tugdeck/src/__tests__/permission-mode.test.ts` — pure-logic coverage.
- **`Shift+Tab` wiring uses the existing keybinding + responder pattern, not a new `substrate-responders.ts`** (deviation): `CYCLE_PERMISSION_MODE` added to `action-vocabulary.ts`; a `{ key: "Tab", shift: true, scope: "key-card" }` binding in `keybinding-map.ts`; the handler registered on the dev card's existing `card-content` responder. This is the idiomatic mechanism (same as `FOCUS_PROMPT` ⌘K) and the `substrate-responders.ts` file the artifacts imagined does not exist in the codebase.
- Modified: `tugdeck/src/components/tugways/cards/dev-card.tsx` — `usePermissionMode` call, `CYCLE_PERMISSION_MODE` handler, and `<PermissionModeChip>` mounted **leftmost directly in `indicatorsContent`** (deviation: direct mount like the route/project/session chips, not via the dev placement-experiment harness, which is for experiments not production indicators).
- Modified: `tugdeck/src/lib/code-session-store.ts` + `code-session-store/{events,reducer}.ts` — `setPermissionMode()` method → `set_permission_mode` event → `send-frame` reducer effect (no transcript-state change, per [D03]).
- Modified: `tugcode/src/permissions.ts` + `types.ts` — added `"auto"` to the `PermissionMode` / `PermissionModeMessage.mode` unions so the type is honest about the 4th cycle mode (confirmed real via the terminal; runtime already forwarded any mode string, so this is a type-correctness change, not a protocol change).
- Verified: `tugdeck/src/lib/session-metadata-store.ts` already exposes `permissionMode`.
- New: tugbank key `dev.permission-mode/<cardId>` for per-card persistence per [D07].

**Tasks:**
- [x] Implement `PermissionModeChip` reading `SessionMetadataStore` via `useSyncExternalStore`. Display-only per [D13] — no click affordance. Renders a two-line `TugBadge` (`layout="label-top"`, `label="Mode"`, `size="sm"`, `role="agent"`) per [#step-0] / [D01]; pre-populates from the per-card tugbank value before live metadata lands ([D07]).
- [x] Do NOT width-stabilize — the chip's width tracks the current mode label and reflows when the mode cycles, per [R01].
- [x] Register the `Shift+Tab` cycle (4-way per [D02]: `default → acceptEdits → plan → auto → default`). Built via the `CYCLE_PERMISSION_MODE` keybinding (`scope: "key-card"`, no `preventDefaultOnMatch` so ⇧⇥ falls through to reverse-tab nav on non-dev cards per [R02]) + a handler on the dev card's `card-content` responder. **`auto` confirmed as a real mode** (user-supplied terminal screenshots show `accept edits → plan mode → auto mode → default`); `tugcode`'s type union was extended with `"auto"` to match.
- [x] Persist mode per-card via tugbank `dev.permission-mode/<cardId>` per [D07]; restore on card mount and send `permission_mode` IPC once the session reports its initial mode, aligning the live session (race-free: waits for both live mode known AND persisted value loaded; a manual cycle supersedes a pending restore).
- [x] Mount chip into Z4B at leftmost position (direct in `indicatorsContent`).

**Tests:**
- [x] Pure-logic: `cyclePermissionMode(current) → next` for all 4 modes + wrap; null / out-of-cycle modes reset to `default` (`permission-mode.test.ts`).
- [x] Pure-logic: `formatPermissionMode` labels + `null → "…"` + unknown-mode fallback; `parsePersistedPermissionMode` tagged-value parsing (the testable half of the tugbank round-trip).
- [~] Real-app: mount a card, observe chip text, send `Shift+Tab`, assert label flips — **deferred: app-tests offline (recent build changes).** Re-enable when app-tests are back.
- [~] Real-app: cycle mode, close card, reopen; assert chip restores — **deferred (app-tests offline).**
- [~] Real-claude: round-trip `permission_mode`; assert `system_metadata.permissionMode` confirms — **deferred (app-tests offline).**

**Checkpoint:**
- [x] `cd tugrust && cargo nextest run` — 1313 passed, 9 skipped (warnings-as-errors clean).
- [x] `cd tugcode && bun test` — 484 pass / 0 fail. (Also fixed the pre-existing `tugcode` `tsc` baseline: `ActiveTurn` 2-arg constructor, `UserMessage.content` shape, `ContentBlock[]` typing — `tsc --noEmit` now exits 0.)
- [x] `cd tugdeck && bun test` — 3047 pass / 0 fail (8 new); `tsc` clean; token lint clean.
- [x] `just app-test permission-mode-chip` — `at0088-permission-mode-chip.test.ts` PASSES (app-tests back online): asserts the chevron renders, `Shift+Tab` advances the mode, and the chevron menu sets it.

**Step 1 follow-ups (post-implementation, user-directed):**
- [x] Chip moved to the **right** end of the Z4B cluster (`route | project | session | permission-mode`).
- [x] `Shift+Tab` now updates the chip — via the optimistic-update path (see the [D03] revision; there is no metadata round-trip).
- [x] **Chevron popup menu on `TugBadge`** (revisits [D13] for this chip — the permission chip is now interactive). New `TugBadge` props `menuItems` / `menuSenderId` / `chevron` / `menuAriaLabel`: when `menuItems` is present the badge becomes a `TugPopupMenu` trigger and renders a chevron hint vertically centred to the right of the content (two-line content is wrapped in a `.tug-badge-stack` so the chevron never disturbs the text layout). Menu items dispatch their `action` through the chain [L11] (mirrors `TugPopupButton`). The permission chip's items dispatch `set-value` (not `select-value`, which the prompt entry claims for route selection) routed to the dev card's **form responder** `setValueString` slot → `setMode` — because the card-content responder is a *sibling*, not an ancestor, of the form responder in the chain (hooks read parent context at call-site), so the control-dispatch walk from the prompt entry reaches the form responder but not card-content. Gallery demo added; `data-item-id` added to `TugPopupMenu` items for testability.
- [x] `auto` confirmed real via user terminal screenshots; cycle order `default → acceptEdits → plan → auto` stands.
- [x] **Mode chip width-stabilized for its own values** (this chip only — [R01]'s opt-in path). The value line stacks the shown label and a hidden sizer per menu mode in one grid cell (`permission-mode-chip.css`), reserving the widest label so cycling never reflows the chip. `at0088` pins it: chip width is identical across two different-length modes.
- [x] **Mode menu opens above the chip.** `TugPopupMenu` gained a `side` prop; `TugBadge` derives it from the chevron direction (`chevron="up"` → `side="top"`), so the bottom-anchored chip's menu pops upward.
- [x] **Value centered, bigger chevron, menu left-aligned.** Value centered within the reserved width (`justify-items: center`); chevron bumped `0.75em` → `1em`; menu `align` `"end"` → `"start"` (left edge lines up with the badge). All in the components.
- [x] **Menu teaching header.** `TugPopupMenu` label entries gained an optional `icon`; `TugBadge` gained a `menuHeader` prop (a non-interactive label + separator at the top). The Mode menu shows "⬆ Tab to cycle" (`ArrowBigUp`) — a non-selectable hint that the mode can also be cycled with the keyboard. `at0088` pins that the header is present and carries no `data-item-id` (unselectable).

---

#### Step 1c: Local slash-command dispatch + completion integration {#step-1c}

**Depends on:** #step-1

**Commit:** `feat(dev-card): local slash-command dispatch + /permissions`

**References:** [D23] local slash-command dispatch model, [D14] slash popup excludes unsupported, [D13] Z4B indicator-only, [L02] external state via store, [L11] controls emit actions through the responder chain, (#slash-cmd-inventory, #strategy)

**Problem statement.** Slash commands today are 100% claude-sourced and pass-through. `SessionMetadataStore.getCommandCompletionProvider()` (`session-metadata-store.ts:244`) returns only what claude reports in `system_metadata` (`slash_commands` + `skills` + `agents`, merged/deduped). At submit, `performSubmit` (`tug-prompt-entry.tsx:844`) strips only the route prefix and calls `codeSessionStore.send()` — there is **no interception**. So a typed `/permissions` is sent to claude as a user message, and claude (stream-json / print mode) answers "`/permissions` isn't available in this environment." Every terminal-rendered-locally command in [#l01-slash-cmd-inventory] (`/model`, `/rewind`, `/diff`, …) bounces the same way. Steps 2b / 7 / 8 / 9 / 10 / 12 each list "Modified: slash-command popup routing" as if a routing layer exists — none does. This step builds it once so those steps become a one-line registry entry plus their surface.

**Goal.** One dispatch layer with three parts: (1) a registry of locally-handled commands, (2) the registry merged into the slash popup, (3) submit-time interception that routes a typed local command to a graphical surface via the responder chain instead of sending it to claude. Ship `/permissions` as the first consumer — reusing the mode sheet the chip already opens.

**Artifacts:**
- New: `tugdeck/src/lib/slash-commands.ts` — `LOCAL_SLASH_COMMANDS` registry (`{ name, description, takesArgs? }[]`, popup order) + `matchLocalSlashCommand(text) → { name, args } | null` (args `""` for no-arg commands; arg-accepting commands capture the remainder). Pure data + lookup — the single source of truth that [#step-2b] / [#step-7] / … extend and that [D14]'s allowlist ([#step-13]) reads.
- New: `RUN_SLASH_COMMAND` action in `action-vocabulary.ts`, payload `{ value: <command-name>, args: string }` (args `""` for no-arg commands) — carries args from the start so `/btw <text>` / `/add-dir <path>` ([#step-13]) need no reshape.
- New: a small `useKeyCardDispatch` hook (or an existing equivalent) over `ResponderChainContext` returning `(event) => manager?.sendToKeyCard(event) ?? false` — the key-card-scoped dispatch the prompt entry uses (the same walk `CYCLE_PERMISSION_MODE` travels).
- Modified: `dev-card.tsx` — the local-command completion entries are merged at the **dev-card composition layer**, where the `/` provider is already assembled (`dev-card.tsx:386`, wrapping `getCommandCompletionProvider()` in `wrapPositionZero`). Compose the store provider with a local-command provider there, deduped. `SessionMetadataStore` stays generic — local commands do not leak into the gallery popup, and the store's `category` union is untouched. [D14] allowlist *filtering* of claude's commands stays [#step-13].
- Modified: `tug-prompt-entry.tsx` `performSubmit` — before `codeSessionStore.send()`, recognize a command in either form (a bare `/name` typed without the popup, or a lone accepted command atom — the U+FFFC placeholder is the only text) and run `matchLocalSlashCommand`. A *local* match → dispatch `RUN_SLASH_COMMAND` **key-card-scoped**; handled → clear + return; otherwise (claude command atom, plain text, or no handler — gallery) → fall through to `send()`. Runs before the send-readiness gates (transport-independent). The completion engine is untouched — accepting any command inserts an atom uniformly.
- Modified: `tug-text-editor/completion-extension.ts` + `tug-text-editor/keymap.ts` — **two latent keyboard-pipeline fixes** (see Spec S03): the active typeahead, and the editor's submit-Enter handler, each `stopPropagation` the Enter they consume, so an Enter that opens a sheet mid-event can't bubble on to the document pipeline's Stage-2 default-button activation and dismiss the just-opened sheet (the "flash").
- Modified: `dev-card.tsx` — register the `RUN_SLASH_COMMAND` handler on the **card-content responder** (next to `CYCLE_PERMISSION_MODE`); key-card dispatch lands there directly (no `parentId` pin). The prompt entry's `useKeyCardDispatch` does the dispatch on submit; this handler resolves the command via the registry and opens its surface.
- Modified: `permission-mode-chip.tsx` / `dev-card.tsx` — host the permission sheet at `DevCardBody` (one `useTugSheet`); the chip's `onClick` and the `RUN_SLASH_COMMAND` handler share that single opener (the chip stops owning its own sheet). Focus restores to the prompt editor on dismiss ([L23], confirmed by `at0089`).

**Spec S03: local slash-command dispatch — completion is uniform; local/remote splits at submit** {#s03-slash-dispatch}
- **Completion is generic and uniform.** Accepting *any* slash-command suggestion (Tab / Enter / click) inserts a `type:"command"` atom and dismisses the popup — identical for local and remote (claude) commands. The completion engine draws **no** local/remote distinction and has no command-specific code. The local-command provider's items are the same shape as claude's; they're merged into the `/` popup for discoverability.
- **The split happens once, at submit.** `performSubmit` recognizes a command in either form — a bare `/name` typed without the popup, or a **lone accepted command atom** (the U+FFFC placeholder is the only text; `atom.value` is the name) — and runs `matchLocalSlashCommand`. A *local* command dispatches `RUN_SLASH_COMMAND`; everything else (a claude command atom, plain text) flows on to `send()` unchanged.
- `RUN_SLASH_COMMAND` is **key-card-scoped** ([L11]) — the same walk `CYCLE_PERMISSION_MODE` uses — landing on the card-content responder, which owns the surface. The match runs **before** the `canSubmit` / disabled / blocked-submit gates (transport-independent, like `Shift+Tab`). If no responder handles it (a host with no card-content handler, e.g. the gallery), it falls through to `send()`.
- **The card-content handler is compile-time-exhaustive over the registry (B).** `RUN_SLASH_COMMAND` is `handled` by handler *presence*, so an unmapped entry would be silently swallowed. The handler is a total `Record<LocalCommandName, …>` (`never` check) and reads state fresh from the store ([L07]).
- **Two latent keyboard-pipeline fixes (found here).** A key the editor/typeahead fully handles must not *also* drive the document pipeline's Stage-2 *Enter→default-button activation*. Without this, an Enter that opens a sheet mid-event (accept or submit) bubbles on and clicks the just-opened sheet's primary button, dismissing it instantly (the "flash"). Fixes: (1) the active typeahead `stopPropagation`s the keys it consumes (`completion-extension.ts`); (2) the editor keymap `stopPropagation`s an Enter it handles as submit (`keymap.ts` `handleEnter`). Both are pre-existing bugs any accept/submit-opens-a-surface flow would have hit.

**Tasks:**
- [x] Add `slash-commands.ts` with `LOCAL_SLASH_COMMANDS` (seed: `permissions`, no args) + `matchLocalSlashCommand` returning `{ name, args }`.
- [x] Add `RUN_SLASH_COMMAND` to `action-vocabulary.ts` (`value: { name, args }`).
- [x] Add `useKeyCardDispatch` over `ResponderChainContext` (no existing equivalent — `use-key-card.tsx` only reads the id; new `use-key-card-dispatch.ts` mirrors `useControlDispatch` over `sendToKeyCard*`).
- [x] **Uniform completion:** accepting any slash command (Tab/Enter/click) inserts a command atom + dismisses the popup — the completion engine has no local/remote code. Local items share claude's shape and are merged into the `/` popup.
- [x] **Split at submit:** `performSubmit` recognizes a command (bare `/name` text OR a lone command atom) and runs `matchLocalSlashCommand`; local → key-card dispatch `RUN_SLASH_COMMAND` (clear + return); else → `send()`. Runs before the send-readiness gates (transport-independent). The handled branch does not run `onAfterSubmit` (that refocuses the editor for a *sent message*).
- [x] **Two latent keyboard-pipeline fixes:** the active typeahead (`completion-extension.ts`) and the editor's submit-Enter handler (`keymap.ts`) each `stopPropagation` the Enter they consume, so an Enter that opens a sheet mid-event can't bubble to the pipeline's default-button activation and dismiss it (the "flash"). Regression-guarded by `at0089`.
- [x] Compose the local-command completion provider into the dev-card `/` provider (`dev-card.tsx:386` via new `completion-providers/local-commands.ts`); `SessionMetadataStore` left generic. The provider is a plain, no-arg generator of command-atom items.
- [x] Register the `RUN_SLASH_COMMAND` handler on the card-content responder (no `parentId` pin) driven by a **compile-time-exhaustive `Record<LocalCommandName, …>`** (B — a registry entry without a surface is a type error); the handler reads `permissionSheet` fresh each render via the responder live-lookup ([L07]) and opens the command's surface.
- [x] Lift the permission sheet to `DevCardBody` via the new `usePermissionSheet` hook; the chip's `onOpenSheet` and the `/permissions` handler share one opener; focus restore to the prompt editor on dismiss confirmed by `at0089`.

**Tests:**
- [x] Pure-logic: `matchLocalSlashCommand` — no-arg exact match, no-arg-with-args → null, unknown `/foo` → null, non-command → null (`slash-commands.test.ts`). The arg-capture branch activates only for `takesArgs` commands; the seed registry has none, so that path lands with `/btw` ([#step-13]) — pinned as a deferral in the test rather than faked.
- [x] Pure-logic: the local-command completion provider lists/filters registry commands, and `mergeCommandProviders` concatenates local-first + dedups by label against the store provider (`slash-commands.test.ts`).
- [x] Real-app (`at0089-slash-permissions.test.ts`): type `/permi`, accept from the popup → a command atom is inserted and the popup dismisses (the sheet does **not** open on accept); submit → the sheet opens, **no transcript row** appears (DOM state, not a `send()` spy), and the line clears. The sheet **stays open** through a 400 ms beat (regression guard for the flash). Pick a mode; the chip reflects it; dismiss restores focus to the editor ([L23]).
- [x] Real-app: type `/commit` and submit raw; an optimistic row appears and no sheet opens (the submit-time matcher discriminates local from pass-through).

**Checkpoint:**
- [x] `cd tugdeck && bun test` — 3059 pass / 0 fail; `tsc --noEmit` clean.
- [x] `just app-test slash-permissions` — `at0089` VERDICT: PASS (1/1). `at0088` (chip click → sheet) re-run green — the sheet-ownership lift did not regress it.

**What this step does NOT do:**
- Does not filter claude's reported commands by the [D14] allowlist — that is [#step-13]; this step only adds local commands and the merge seam.
- Does not build the `/model` picker (that surface is [#step-2b], gated on [#step-6]); `/model` joins the registry when its sheet exists.
- Ships **no live slash command** (follow-up correction): the permission *mode* control is the Z4B chip + `Shift+Tab`, **not** a slash command, so the registry is empty and the dispatch infra is dormant until [#step-1-6] (`/permissions`) or [#step-2b] (`/model`) register the first command. `/permissions` is its own feature — the rules editor — planned in [#step-1-5] / [#step-1-6], **not** this mode sheet.

---

#### Step 1.5: Empirical capture — Claude Code `/permissions` rules read/write {#step-1-5}

**Depends on:** #step-1c

**Commit:** `test(tugcast): capture how Claude Code /permissions reads + writes rules`

**References:** [D06] protocol baseline, [D10] empirical-capture-before-design (precedent), (#slash-cmd-inventory)

**Problem statement.** `/permissions` is not the permission-*mode* chip — it is Claude Code's tool-permission **rules editor** (the screenshot: tabs `Allow` / `Ask` / `Deny` / `Workspace` / `Recently denied`, tool-matcher patterns like `Bash(… init:*)`, add-rule + search). Before designing the dev-card sheet ([#step-1-6]) we must know *where the rules live and how they're read and written* — the same de-risking [#step-7a] does for `/rewind`. Building against an assumed `settings.json` shape and silently getting the scope or live-reload behavior wrong would be the [R03]-class trap.

**Goal.** Pin the rules data model and the read/write/apply mechanism as the empirical spec for [#step-1-6].

**Tasks (investigation — findings ARE the spec):**
- [x] Drive Claude Code's `/permissions` in the terminal: add and remove a rule in each of `Allow` / `Ask` / `Deny`; observe **which file** each write lands in and at **what scope** — user `~/.claude/settings.json`, project `.claude/settings.json`, local `.claude/settings.local.json` — and the default scope per tab/action. → captured via the six-tab UI + on-disk files: this repo's rules live in `.claude/settings.local.json` (Local, gitignored); Project absent, User has no `permissions` block. Precedence Managed > CLI > **Local > Project > User**, rules **merge (union)**. Add-rule default scope = Local (terminal picker offers Local/Project/User; one minor item to confirm against the picker's default — non-blocking).
- [x] Pin the on-disk **shape**: `permissions: { allow, ask, deny }` (+ `additionalDirectories` for `Workspace`) and the matcher-pattern grammar (`Bash(cmd:*)`, `Read(path)`, `WebFetch(domain:…)`, …). → confirmed 1:1 against `settings.local.json`; grammar `Tool` | `Tool(specifier)`; `defaultMode` is the *mode* (Step 1), not a rule, but shares the object.
- [x] Determine **`Recently denied`'s source**: is it persisted, or a session log of denied tool calls? Cross-check against the `control_request_forward` (`is_question:false`) deny decisions the dev card already sees on the wire ([#step-15]). → **runtime, not persisted**; UI says "denied by the auto mode classifier"; sourced 1.6-side from a session deny log cross-checking the wire denials.
- [x] Determine **apply semantics**: does the claude process tugcode spawned pick up a `settings.json` edit **live**, or only on respawn? (Decides whether [#step-1-6] writes-and-continues or writes-and-respawns.) → **LIVE** (docs: Claude Code watches settings files and reloads `permissions`/`hooks` without restart, firing `ConfigChange`). → 1.6 **writes-and-continues**. *Confirm-at-1.6-start caveat:* not yet verified for the print/stream-json child specifically — cheap mid-session deny-rule check when 1.6 begins; fall back to respawn only if it (unexpectedly) doesn't watch.
- [x] Determine the **read path for the dev card**: does any of this come over stream-json (`system/init`?) or is it purely filesystem? Decide the dev-card access route — most likely a tugcast filesystem read/write of the settings files, scope-aware. → **purely filesystem** (`system/init` carries tools + mode, not rules); route is **tugcast filesystem read/write, scope-aware**.
- [x] Record findings in `transport-exploration.md` — the concrete file / scope / shape / apply contract that [#step-1-6] implements against. → recorded under "`/permissions` rules — read/write/apply capture".

**Tests / Checkpoint:**
- [x] Findings documented: the concrete file / scope / shape / apply contract that [#step-1-6] implements against.

---

#### Step 1.6: `/permissions` rules editor — full terminal parity {#step-1-6}

**Depends on:** #step-1c, #step-1-5

**Commit:** `feat(dev-card): /permissions rules editor (allow/ask/deny/workspace/recently-denied)`

**References:** the rules data model pinned by [#step-1-5], [D14] slash popup, [D15] card-scoped overlays, [L02] store, [L11] chain, (#slash-cmd-inventory). **Supersedes [#step-9].**

**Goal.** The full `/permissions` rules editor matching the terminal — a tabbed, card-scoped sheet over the tool-permission rules — wired to the read/write/apply mechanism [#step-1-5] pinned. Registering `/permissions` here is the first live consumer of the [#step-1c] dispatch layer.

**Artifacts:**
- New: `permission-rules-editor.tsx` (tabbed `TugSheet`: `Recently denied` / `Allow` / `Ask` / `Deny` / `Workspace`) + `.css`, plus `usePermissionRulesSheet` (card-hosted opener, mirrors `usePermissionSheet`).
- New: `lib/permission-rules.ts` (pure: scopes/buckets/`ResolvedRule`, matcher parse, response parse, scope-union + dedup, search filter) and `lib/permission-rules-store.ts` (`PermissionRulesStore` over the endpoint + `BucketDataSource` for `TugListView`).
- New: tugcast plumbing — `crates/tugcast/src/permissions.rs` (`GET /api/permissions?cwd` reads user/project/local scope buckets; `POST /api/permissions/rule` read-modify-writes one rule, preserving other keys), wired in `server.rs`, declared in `main.rs`. Loopback-guarded like the other `/api` handlers. **Write-and-continue** (no respawn — apply is live per [#step-1-5]).
- Modified (tugways primitives): `TugSheet` gains `displayWidth: "standard" | "wide"` (wide = 90% of the host pane, for information-rich sheets); `TugTabBar` gains `addable?: boolean` (suppress the card-type `[+]` for a fixed tab set). The editor opens `wide` and uses `TugTabBar` for its tabs.
- Modified: `lib/slash-commands.ts` — register `permissions` (literal-union `LocalCommandName` restored + the exhaustive `Record<LocalCommandName,…>` handler in `dev-card.tsx`); `/permissions` → opens this editor.
- New: `at0090-permissions-rules-editor.test.ts` real-app test.

**Tasks:**
- [x] Tabbed sheet: `Allow` / `Ask` / `Deny` (rule lists) + `Workspace` (additional dirs) + `Recently denied`. Rule lists via windowed `TugListView` + `useFilteredDataSource`. Tabs use **`TugTabBar`** (fixed set: non-closable cards, `addable={false}`); it dispatches `selectTab` through the chain ([L11]) and the sheet body's `useResponderForm` responder updates the active tab. Sheet opens `displayWidth="wide"` so the information-rich content isn't cramped.
- [x] Rule rows render the matcher string over its scope label; **add a rule** (pattern input + scope selector defaulting to **Local**), **remove** (per-row), **search** filter — terminal parity.
- [x] `Recently denied` renders the terminal's empty-state ("No recent denials."). *No persisted feed exists yet — denials are the runtime `control_request_forward` events the dev card surfaces in [#step-15]; the promote-to-rule affordance lands with that feed.*
- [x] Read + write the settings file(s) at the scope [#step-1-5] determined (`user`/`project`/`local`, resolved under the session `cwd`); apply is **live** so the sheet writes-and-continues (no respawn).
- [x] `/permissions` slash command → opens the editor (raw-text / command-atom submit → `matchLocalSlashCommand` → key-card `RUN_SLASH_COMMAND`); card-scoped overlay per [D15], focus restores on dismiss. *cwd resolves from the card's bind-time `projectDir` (so `/permissions` works before claude's first metadata frame), falling back to live `system_metadata.cwd`.*

**Tests:**
- [x] Pure-logic (`permission-rules.test.ts`): matcher parse, response parse, scope-union precedence + dedup, search filter. Rust unit tests (`permissions.rs`): scope→path, read buckets, read-modify-write (preserve keys / idempotent add / remove / newline). `slash-commands.test.ts` updated for the registered `permissions`.
- [x] Real-app (`at0090`): type `/permissions` → editor opens; assert the five tabs + switch; add a rule → assert it's written to `<cwd>/.claude/settings.local.json`; remove → assert it's gone. Writes target a per-test temp `projectDir` (never the real repo).

**Checkpoint:**
- [x] `cd tugrust && cargo nextest run` (648 pass) · `cd tugdeck && bun test` (3066 pass) · `just app-test permissions-rules-editor` (PASS)

**What this step does NOT do:**
- Does not touch the permission *mode* chip / `Shift+Tab` cycle — mode and rules are distinct features ([#step-1] vs here).
- Does not implement hunk-level or per-call approval UI — that is the `control_request_forward` flow ([#step-15]).

---

#### Step 2: Model indicator chip in Z4B {#step-2}

**Depends on:** #step-1

**Commit:** `feat(dev-card): model indicator chip in Z4B (display-only)`

**References:** [D01] Z4B chrome anchor, [D04] SessionMetadataStore hub, [D09] model-confirm in transcript, [D13] Z4B indicator-only, (#z4b-chrome-layout)

**Artifacts (as built):**
- New: `tugdeck/src/components/tugways/cards/model-chip.tsx` — display-only chip. **No `.css`**: it composes `TugBadge` and adds no styling, so it is `.tsx`-only per the component-authoring "Compositional Component" rule (same shape as `DevSessionIdBadge` and the project badge).
- New: `tugdeck/src/lib/model-label.ts` — pure `formatModelLabel` helper (`claude-opus-4-8[1m]` → `Opus 4.8 · 1M`), mirroring `model-context-max.ts`'s `[1m]`-suffix discipline.
- New: `tugdeck/src/lib/__tests__/model-label.test.ts` — pure-logic coverage.
- Modified: `tugdeck/src/components/tugways/cards/dev-card.tsx` — `<ModelChip>` mounted directly in `indicatorsContent`, right of `PermissionModeChip` (cluster: `route | project | session | permission-mode | model`). **Direct mount** like the other display-only chips, not via the placement-experiment harness (deviation from the artifact list's "placement-experiment" note — the harness is for experiments, not production indicators).

**Tasks:**
- [x] Implement `ModelChip` reading `model` from `SessionMetadataStore` via `useSyncExternalStore`. Display-only per [D13] — no click affordance. Renders a two-line `TugBadge` (`layout="label-top"`, `label="Model"`, `size="sm"`, `role="agent"`) per [#step-0] / [D01]. **Never hides on missing data** (user-directed correction): when no model has been reported the chip stays visible and escalates to `role="caution"` with a `?` value and a `TriangleAlert` icon, mirroring the Claude Code version chip's drift treatment ([dev-route-indicator-badge.tsx]) — an absent model is surfaced, not swallowed.
- [x] Format display: `Opus 4.8 · 1M` from raw `claude-opus-4-8[1m]` (`formatModelLabel`). Unparseable / legacy ids fall back to the raw string, matching `formatPermissionMode`'s discipline.
- [x] Do NOT width-stabilize — the chip's width tracks the model label, per [R01].
- [x] Synthetic `assistant_text` confirmation from `model_change` continues to render in the transcript per [D09] — no suppression, no banner (this step adds no transcript / banner code).

**Tests:**
- [x] Pure-logic: `formatModelLabel("claude-opus-4-8[1m]") === "Opus 4.8 · 1M"` + base/extended/release-date/no-version/unparseable cases (`model-label.test.ts`, 5 tests).
- [~] Real-app: chip text matches `system_metadata.model` — **deferred.** The chip reads `FeedId.SESSION_METADATA` on the shared connection feed, which the `driveDevSession`/`ingestFrame` harness path (CodeSessionStore-scoped) does not reach; a metadata-feed injection verb would be net-new harness plumbing. Display-only behavior is covered by the pure-logic formatter + the existing two-line `TugBadge` real-app coverage (`at0087`). Land the real-app check alongside [#step-2b] (`/model` picker), which exercises the live `model_change` round-trip end-to-end.

**Checkpoint:**
- [x] `cd tugdeck && bun test` — 3089 pass / 0 fail (5 new); `tsc --noEmit` clean.
- [~] `just app-test model-chip` — deferred with the real-app test above; folds into [#step-2b].

**Step 2 follow-up — the live-metadata gap (user-directed investigation):** review surfaced that on a freshly-opened / restored dev card, the model chip honestly shows `?` while the version and `MODE` chips *look* populated. Empirical tracing (live ledger query + spawning the real `claude` binary the way tugcode does) proved this is **not a tugcode bug** — it is claude's stream-json protocol: in `--input-format stream-json` mode claude emits **nothing — not even `system/init` — until it receives the first user message** (confirmed: stdin held open 4s with no message → 0 bytes; the `session.ts:2231` comment says the same). The version chip masks the gap with a *global* last-known-version tugbank fallback; the `MODE` chip masks it with a *per-card* persisted-or-`default` fallback; the model chip has no fallback, so it is the only honest one. Closing this gap turn-free is [#step-2a].

---

#### Step 2a: `initialize` control-request handshake + metadata replay on bind {#step-2a}

**Depends on:** #step-2

**Commit:** `feat(tugcode+tugcast): initialize handshake + session-metadata replay on bind`

**References:** [D04] SessionMetadataStore hub, [D06] protocol baseline, [D13] Z4B indicator-only, [D14] (the `initialize` `commands` list feeds the allowlist source), Risk R04 (strict shapes / drift), [L02] external state via store, (#z4b-chrome-layout, #inputs-outputs). Empirically-modeled like [#d10-rewind-matches-terminal] / [#step-1-5] — the findings below ARE the spec.

**Problem statement.** A dev card cannot show this session's *live* model / version / mode until claude has been spoken to, because claude's stream-json mode is silent until the first user message ([#step-2] follow-up). Two distinct gaps result: (1) a **resumed / known** session has accurate metadata persisted in the ledger, but tugcast only replays its *in-memory* `latest_metadata` slot on bind — which is `None` in a fresh tugcast process — so the persisted truth is never surfaced; (2) a **brand-new** session has no metadata at all until the first turn. Both are closeable **without provoking a turn**: claude answers a standard `initialize` control request at spawn time with its capabilities, and the ledger already holds the last-known live metadata for resumed sessions.

**Goal.** Populate every Z4B chip with honest, session-accurate data the moment it is knowable — turn-free — by (1) adopting claude's `initialize` control-request handshake in tugcode and forwarding its capabilities, and (2) replaying the persisted ledger `system_metadata` row on bind in tugcast for resumed/known sessions. The honest `?` caution chip ([#step-2]) remains only for the genuinely-unknowable residue.

**Empirical findings (verified against `claude` 2.1.158 + the live `debug-main` ledger) — these ARE the spec:**

- **claude is silent until the first user message.** Spawned `--output-format stream-json --input-format stream-json --verbose --permission-mode default` with stdin held open and no message → **0 bytes / no `system/init`** after 4s. Send one `user` message → `system/init` arrives *first* (carrying `model`, `permissionMode`, `claude_code_version`/`version`, `cwd`, `session_id`, `tools`, …), then the response. So `system/init` is the **only** source of the *exact live* current-model id, and it is strictly post-first-turn.
- **The `initialize` control request is answered turn-free.** Sending only `{"type":"control_request","request_id":"…","request":{"subtype":"initialize"}}` (no user message) → an **immediate** `control_response` with `response.subtype:"success"`. This is the documented SDK handshake (Python / TS / Go / Elixir all send it at spawn).
- **What `initialize` returns** (top-level keys of `response.response`): `account`, `agents`, `available_output_styles`, `commands`, `models`, `output_style`, `pid`.
  - `commands`: full slash-command catalog — array of `{ name, description, argumentHint }` (24 entries observed). Turn-free source for the slash popup + the [D14] allowlist.
  - `models`: the model **picker list** — array of `{ value, displayName, description, supportsEffort?, supportedEffortLevels?, supportsAdaptiveThinking?, supportsFastMode?, supportsAutoMode? }`. Observed: `default` / `sonnet` / `sonnet[1m]` / `haiku`. **This is the structured source [#step-2b]'s `/model` picker needs** (no more hardcoded model list).
  - `agents`, `available_output_styles` (`['default','Proactive','Explanatory','Learning']`), `output_style` (`'default'`), `account` (`{tokenSource, apiKeySource, apiProvider}`).
- **What `initialize` does NOT return:** the exact current **model id**, **version**, **permissionMode**, **cwd**, or **session_id**. The default model appears only as **prose** inside `models[0]` (`value:"default"`, `displayName:"Default (recommended)"`, `description:"Use the default model (currently Opus 4.8 (1M context)) · …"`). There is **no** structured "current/default model id" field.
- **The default-model convention.** `models[0]` is always `value:"default"` / `displayName:"Default (recommended)"`. Confirmed: spawning with **no `--model`** → `system/init.model = claude-opus-4-8[1m]`; spawning `--model sonnet` → `claude-sonnet-4-6`. So on a new no-`--model` session claude resolves the **account default**, and `"Default (recommended)"` is the correct, honest pre-turn label for the model chip (it sharpens to the exact id on first `system/init`).
- **tugcode already knows mode (and often model) at spawn.** `buildClaudeArgs` always passes `--permission-mode <mode>` and passes `--model <model>` when set (`session.ts:437-451`). So the *mode* is known to tugcode at spawn independent of claude.
- **The ledger holds accurate per-session metadata.** Every persisted `session_metadata` row carries `model` + `version` + `permissionMode` together (e.g. `claude-opus-4-8[1m]` | `2.1.157` | `acceptEdits`). On bind, `do_spawn_session` replays only the in-memory `LedgerEntry.latest_metadata` slot (`agent_supervisor.rs:1937-1958`), which is `None` for a session whose `system/init` wasn't captured in *this* tugcast process; `get_session_metadata` (the accurate persisted row) is **never** replayed on bind.

**Decision — `#3 "provoke a fake turn"` is REJECTED.** A turn-free path exists and is standard (the `initialize` handshake), so synthesizing a dummy user message to force `system/init` is unnecessary and would risk surfacing a spurious turn / cost. We never send a fake turn.

**Artifacts:**
- New / modified (tugcode): send an `initialize` control_request to claude immediately after spawn (before/independent of the first user turn) and forward its `control_response` capabilities to the frontend. Define a new outbound IPC type carrying the turn-free capabilities — at minimum `models` and `commands` (plus `agents`, `available_output_styles`, `output_style`, `account`). Strict-typed per [Q13]/[R04]; unknown fields dropped. Recompile required (`feedback_tugcode_compile` — tugcode is bun-compiled, no HMR).
- Modified (tugcast `agent_supervisor.rs`): on bind, when `LedgerEntry.latest_metadata` is `None`, fall back to `ledger.get_session_metadata(claude_session_id)` and replay **that** persisted row onto `SESSION_METADATA` (rewrapped as `FeedId::SESSION_METADATA`, same path as the live publish). Resumed/known sessions then populate all chips immediately, self-correcting when fresh `system/init` lands. `cargo build` + app relaunch required (Rust, no HMR).
- Modified (tugdeck): extend `SessionMetadataStore` (or a sibling capabilities store) to consume the new `initialize`-capabilities IPC; surface `models` + `commands` for downstream consumers. The model chip ([#step-2]) gains a third source below live `system/init` and below the ledger-replayed value: the `initialize` default-model label (`"Default (recommended)"`) for a new no-`--model` session. **Resolution order (most → least authoritative): live `system_metadata.model` → ledger-replayed row → per-card spawn `--model` (if set) → `initialize` default-model label → honest `?` caution.**
- Decide the exact new IPC frame name/shape during implementation (candidate: `session_capabilities`), pinned against a fixture per [D06]; document in `transport-exploration.md` alongside the [#step-1-5] capture.

**Tasks:**
- [ ] **Confirm-at-start:** re-verify the `initialize` request/response shape against the tugcode-spawned print/stream-json child specifically (not just a bare CLI spawn) — the same "confirm against the real child" caveat [#step-1-5] used for live settings reload. If claude's child shape differs, the findings above are the fallback baseline.
- [ ] tugcode: issue the `initialize` control_request at spawn; parse the `control_response`; emit a new strict-typed capabilities IPC (`models`, `commands`, `agents`, `available_output_styles`, `output_style`, `account`). Do **not** block the first user turn on it.
- [ ] tugcast: replay the persisted ledger `system_metadata` row on bind when the in-memory slot is empty (rewrapped as `FeedId::SESSION_METADATA`). Add a unit test mirroring `test_spawn_session_replays_latest_metadata_for_known_session` but seeding the *persisted* row (empty in-memory slot).
- [ ] tugdeck: consume the capabilities IPC; thread `models` to where [#step-2b]'s picker will read it; apply the model-chip resolution order above (new-session shows `"Default (recommended)"`, not `?`).
- [ ] Keep the honest `?` caution chip ([#step-2]) as the final fallback only.
- [ ] Document the `initialize` handshake + capabilities shape in `transport-exploration.md`; note the no-structured-current-model limitation and the `models[0]`=default convention.

**Tests:**
- [ ] Pure-logic (tugdeck): capabilities-IPC parser (`models` / `commands` shape, strict drop of unknowns); model-chip resolution-order predicate (live > ledger > spawn-arg > initialize-default > `?`).
- [ ] Rust unit (tugcast): bind with empty in-memory slot but a persisted ledger row replays exactly one `SESSION_METADATA` frame carrying the persisted model/version/mode; brand-new session (no row, no slot) replays none.
- [ ] tugcode unit / probe: `initialize` request → `control_response` parsed into the capabilities IPC; assert `models` + `commands` present, current-model-id absent (documents the limitation).
- [ ] Real-app: open a **resumed** card → all chips (model/version/mode) populate from the replayed ledger row before any turn. Open a **new** card → model chip reads `Default (recommended)`, version/mode read their honest values, and all sharpen to live `system/init` after the first turn.
- [ ] Drift regression stays clean; `just capture-capabilities` after the tugcode IPC change.

**Checkpoint:**
- [x] `cd tugrust && cargo nextest run -p tugcast` — 762 passed / 1 skipped (warnings-as-errors clean).
- [x] `cd tugcode && bun test` — 497 pass / 0 fail; `tsc --noEmit` clean. Recompiled via `just build-app`.
- [x] `cd tugdeck && bun test` — 3093 pass / 0 fail; `tsc --noEmit` clean.
- [x] `just build-app` — BUILD SUCCEEDED (Rust + tugcode + Tug.app signed); new code live in the debug app.
- [~] Real-claude verify (resumed-card chips pre-turn + new-card `Default (recommended)`) — by-hand against the rebuilt app; awaiting user spot-check.
- [ ] `just capture-capabilities` (drift clean) — real-claude ~2-3 min; the new `session_capabilities` IPC frame is additive (default-branch tolerant in tugcast), so run when convenient to refresh the golden snapshot.

**Status:** [#step-2a-1] / [#step-2a-2] / [#step-2a-3] all implemented, tested, committed, and built. Step 2a complete pending the optional `capture-capabilities` refresh + the by-hand real-claude spot-check.

**What this step does NOT do:**
- Does not build the `/model` picker UI — that is [#step-2b], which consumes the `models` list this step plumbs.
- Does not provoke a fake turn to force `system/init` (rejected above).
- Does not change the [#step-2] chip's honest-`?` behavior except to add higher-priority sources ahead of it; `?` remains the final fallback.

**Sub-step breakdown (implementation order).** Step 2a bundles three independent changes across three build systems; each lands and tests on its own and is committed separately:
- **[#step-2a-1]** tugcast ledger-replay-on-bind (Rust) — self-contained, no dependency on the others; fixes the resumed-card case (all chips populate from the persisted row pre-turn).
- **[#step-2a-2]** tugcode `initialize` handshake + `session_capabilities` IPC (TS, recompile) — defines the new IPC frame.
- **[#step-2a-3]** tugdeck consume `session_capabilities` + model-chip resolution order (HMR) — depends on 2a-2's IPC shape; adds the new-session `"Default (recommended)"` label.

---

#### Step 2a.1: tugcast — replay persisted ledger metadata on bind {#step-2a-1}

**Depends on:** #step-2

**Commit:** `feat(tugcast): replay persisted session metadata on bind`

**References:** [D04] SessionMetadataStore hub, [D14] per-session metadata broadcast, [L02], (#z4b-chrome-layout). Self-contained slice of [#step-2a].

**Problem.** On bind, `do_spawn_session` replays only the in-memory `LedgerEntry.latest_metadata` slot (`agent_supervisor.rs:1937-1958`), which is `None` for a session whose `system/init` wasn't captured in *this* tugcast process (fresh process, or a card bound before its first turn). The accurate persisted row (`persistent_ledger.get_session_metadata`, keyed by claude session id) is never replayed — so a resumed card shows nothing live for model/version/mode until the first turn.

**Findings (verified in source).** `AgentSupervisor.persistent_ledger: Arc<SessionLedger>` is the sqlite handle; `get_session_metadata(claude_session_id) -> Option<SessionMetadataRow>` returns the merged `system_metadata` JSON bytes. `LedgerEntry` holds both `tug_session_id` and `claude_session_id: Option<String>` (the latter set on `session_init`; equal to the tug id for un-forked sessions). The live publish path rewraps as `Frame::new(FeedId::SESSION_METADATA, payload)` (merger `agent_supervisor.rs:3206-3217`); the replay must use the same wrapping so a client subscribed to `SESSION_METADATA` decodes it.

**Tasks:**
- [x] In `do_spawn_session`'s Phase-3 block, when `entry.latest_metadata` is `None`, fall back to `session_ledger.get_session_metadata(id)` — trying `claude_session_id` first, then `tug_session_id` (covers un-forked resume where the two are equal, deduped when identical) — and build a `Frame::new(FeedId::SESSION_METADATA, row.payload)` to replay. In-memory slot still wins when present (it's the freshest). New private helper `persisted_metadata_replay_frame`; the supervisor's sqlite handle is `session_ledger: Option<Arc<SessionLedger>>` (returns `None`/no replay when absent).
- [x] Keep it a no-op for a brand-new session (no in-memory slot, no persisted row → no replay frame), matching `test_spawn_session_with_no_prior_metadata_fires_no_replay`.

**Audit follow-up (capabilities retention, commit `c2104036`).** A post-implementation audit found `session_capabilities` was broadcast once per spawn but never retained — a card binding *after* that one-shot frame (reconnect, HMR remount) would never see the model list, leaving the `/model` picker ([#step-2b]) blank. Fix: add a per-session `latest_capabilities` slot (sibling of `latest_metadata`), populate it in the merger, and replay it on bind. Both slots now replay on bind — metadata first (the chip source), then capabilities (the picker source); the client routes them apart by payload `type`. In-memory only (not persisted): capabilities re-emit on the next new-mode spawn.

**Tests:**
- [x] Rust unit (3, against a real in-memory `SessionLedger`): bind with empty in-memory slot + a persisted ledger row → exactly one `SESSION_METADATA` frame carrying the persisted payload verbatim; ledger present but no row + no slot → none; in-memory slot present → that wins (persisted not consulted). New helper `make_supervisor_with_real_ledger`.
- [x] Rust unit (2, capabilities retention): the capabilities slot replays on bind (carrying the SESSION_METADATA feed id); both slots populated → exactly two replay frames, metadata then capabilities.

**Checkpoint:**
- [x] `cd tugrust && cargo nextest run -p tugcast` — 661 passed / 4 skipped (warnings-as-errors clean).
- [x] `just build-app` — BUILD SUCCEEDED; resumed-card replay verified by-hand live (user spot-check).

---

#### Step 2a.2: tugcode — `initialize` handshake + `session_capabilities` IPC {#step-2a-2}

**Depends on:** #step-2a-1

**Commit:** `feat(tugcode): initialize handshake + session_capabilities IPC`

**References:** [Q13]/[R04] strict shapes, [D06] protocol baseline, (#inputs-outputs). Slice of [#step-2a]; empirical findings in [#step-2a].

**Tasks:**
- [x] Send the `initialize` control_request to claude at spawn (`sendInitializeHandshake` after `installEarlyExitWatcher`, via `sendControlRequest` with a stored `initializeRequestId`); does **not** block the first user turn (the readiness gate is independent). Reset on respawn alongside `sessionInitSeen`.
- [x] **New mode only + hardened write** (follow-up fixes, `06de342b` (gate) + `c2104036` (hardened write)): sending the handshake on a `--resume` spawn caused reopened dead-session cards to loop into `crash_budget_exhausted` instead of resolving to terminal `resume_failed`. Gating to `new` mode stops the loop (**verified by live test**). The precise mechanism is **not fully root-caused** — the prior note claimed "perturbs the classifier," which is unproven and has been removed; the leading hypothesis is the unguarded stdin write racing claude's near-instant resume-failure exit (EPIPE thrown synchronously into the spawn path, crashing tugcode before it emits the `resume_failed` IPC frame → bridge reads it as a retryable generic crash). The write is now wrapped in try/catch (defends against that race regardless of mode; request-id correlation armed only on a successful write), so the gate is belt-and-suspenders. Verified against claude 2.1.158: resume-of-nonexistent fails identically with/without initialize (so resume doesn't need it); fresh `--session-id` answers initialize and survives a full turn. Resumed sessions get their metadata from the [#step-2a-1] ledger replay; the `/model` model list is absent for them until a new-mode spawn (a [#step-2b] fallback concern).
- [x] Intercept the matching `control_response` at the top of `handleClaudeLine` (it arrives turn-free, no active turn — so caught before turn routing; correlated by `request_id`); parse `response.response` strict-typed into a new `SessionCapabilities` outbound IPC carrying `models`, `commands`, `agents`, `available_output_styles`, `output_style`, `account`. Unknown fields dropped; malformed model/command entries skipped. Pure parser in new `src/capabilities.ts` (`buildSessionCapabilities` + `parseInitializeControlResponse`).
- [x] Add `SessionCapabilities` (+ `CapabilityModel` / `CapabilityCommand`) to `types.ts` and the `OutboundMessage` union. (tugdeck `protocol.ts` reader lands in [#step-2a-3].)

**Tests:**
- [x] tugcode unit (`capabilities.test.ts`, 13 tests): a captured `control_response` parses into `session_capabilities` with `models` + `commands` present and the current-model-id **absent** (documents the limitation); malformed entries skipped; missing fields degrade to empty; `parseInitializeControlResponse` correlation + success/error/missing-id branches. The send-at-spawn + intercept-by-id wiring is 3 lines exercised end-to-end by [#step-2a-3]'s real-app test (no hand-rolled subprocess mock, per `feedback_no_mock_store_tests`).
- [ ] Drift regression / `just capture-capabilities` after the IPC change (run in the build/checkpoint pass after 2a.3).

**Checkpoint:**
- [x] `cd tugcode && bun test` — 497 pass / 0 fail (13 new); `tsc --noEmit` clean.
- [ ] recompile (`just build-tugcode`) + `cd tugrust && cargo nextest run -p tugcast` (payload_inspector tolerates the new frame) — in the post-2a.3 build pass.

---

#### Step 2a.3: tugdeck — consume `session_capabilities` + model-chip resolution order {#step-2a-3}

**Depends on:** #step-2a-2

**Commit:** `feat(dev-card): consume session_capabilities; model-chip resolution order`

**References:** [D04], [D13], [L02], Risk R01, (#z4b-chrome-layout). Slice of [#step-2a].

**Routing decision (user-approved).** `session_capabilities` rides the **SESSION_METADATA** feed, not a dedicated one. tugcast's merger detects it (`is_session_capabilities`, sibling of `is_system_metadata`) and rewraps it as `FeedId::SESSION_METADATA` before broadcast — tugdeck's `FeedStore` keeps only the latest payload per feed, so a CODE_OUTPUT consumer would lose it amid transcript frames. `SessionMetadataStore` discriminates the two payload types by `type` and keeps them in **separate snapshot regions** (`models` vs the metadata fields) so neither wipes the other across the shared feed slot. Not stored in `latest_metadata` (that slot is the on-bind `system_metadata` replay source; capabilities re-emit fresh each spawn).

**Tasks:**
- [x] `session_capabilities` → SESSION_METADATA: `is_session_capabilities` detector (`session_metadata.rs`) + merger rewrap-and-broadcast (`agent_supervisor.rs`).
- [x] Parse it in `SessionMetadataStore`: `models: CapabilityModel[]` snapshot field + `parseCapabilityModels` (skips malformed, mirrors tugcode's parser); `_onFeedUpdate` routes by `type`, capturing `models` and `system_metadata` into separate regions that survive each other.
- [x] Apply the model-chip resolution order: live `system_metadata.model` (live **or** the 2a.1 on-bind ledger replay — same `snapshot.model`) → `initialize` default-model label (`models[0].displayName`, "Default (recommended)") → honest `?` caution. (Per-card spawn `--model` is subsumed: claude echoes it back as `system_metadata.model`, arriving via the live path.)

**Tests:**
- [x] Pure-logic (tugdeck `session-metadata-store.test.ts`, 4 new): capabilities `models` parse (malformed skipped); capabilities don't set the live `model`; system_metadata preserves captured `models` and vice versa. tugcast unit (`session_metadata.rs`, 2 new): `is_session_capabilities` detect / non-detect.
- [~] Real-app: resumed card → chips populate pre-turn; new card → model chip reads `Default (recommended)`; both sharpen on first turn. **Deferred to a by-hand real-claude verify** — the metadata feed is process-spawned (tugcast+tugcode), which the CodeSessionStore-scoped harness doesn't drive; covered structurally by the unit tests above.

**Checkpoint:**
- [x] `cd tugdeck && bun test` — 3118 pass / 0 fail; `tsc --noEmit` clean.
- [x] `cd tugrust && cargo nextest run -p tugcast` — 659 run, 659 passed / 4 skipped.
- [x] `just build-app` — BUILD SUCCEEDED; new code live in the debug app. By-hand chip verify awaiting user spot-check.

---

#### Step 2b: `/model` slash command opens picker sheet {#step-2b}

**Depends on:** #step-1c, #step-6

**Commit:** `feat(dev-card): /model slash command opens model picker sheet`

**References:** [D23] local slash-command dispatch, [D13] Z4B indicator-only (**amended** — model is now the second interactive chip), [D15] pane sheets are overlays, (#slash-cmd-inventory)

**Artifacts:**
- New: `model-picker-sheet.tsx` — exports `useModelPicker` (the card-hosted shared sheet, mirroring `usePermissionSheet`) and the `TugListView`-based sheet body.
- New: `model-picker-data.ts` — `KNOWN_MODELS` static fallback + pure `resolvePickerModels(models, activeModel)` resolver.
- Modified: `model-chip.tsx` — converted from display-only `TugBadge` to interactive `TugPushButton` with `onOpenPicker` (mirrors `PermissionModeChip`).
- Modified: register `/model` in the [#step-1c] slash-command registry; its `commandHandlers` entry calls `modelPicker.openModelPicker()` (no bespoke routing — the dispatch layer already exists).
- Modified: `dev-card.tsx` — `useModelPicker({ codeSessionStore, sessionMetadataStore })` wired to the chip's `onOpenPicker` AND the `model` slash-command surface; `renderModelPicker()` mounted in the content region. One sheet, two entry points.

**Tasks:**
- [x] Implement the model picker as a card-hosted shared sheet per [D15], listing available models from the `initialize` list (or the static `KNOWN_MODELS` fallback for resumed sessions). Chip press and `/model` share the one sheet via `useModelPicker` (the established `usePermissionSheet` idiom — chosen over the unused `activeOverlay` state for parity with the sibling chip).
- [x] Highlight current model — `resolvePickerModels` marks the live `SessionMetadataStore` model, or the default option, and surfaces a live model absent from the list as its own labeled row.
- [x] Selection sends `{type: "model_change", model}` (via `DevControlSender.setModel`); sheet dismisses on confirmation.
- [~] Keyboard: the sheet uses `TugListView` (the keyboard-ready substrate, same as the permission sheet); arrow/Enter land with component keyboard navigation, ESC dismisses today via `TugSheet`.

**Tests:**
- [x] Pure-logic: `resolvePickerModels` — live-list vs fallback, active-row marking, default-to-first, live-model-as-own-option (`src/lib/__tests__/model-picker-data.test.ts`, 6 cases).
- [ ] Real-app: type `/model`, observe sheet; pick a model; assert `model_change` IPC outbound + chip updates after `system_metadata`; assert synthetic confirmation lands in transcript per [D09]. **Deferred** to a `just app-test` pass.

**Checkpoint:**
- [ ] `just app-test model-picker-sheet` — deferred with the real-app test above.

**Implementation notes.**
- **Backend was already complete.** `tugcode` already carries the `model_change` inbound type, `isModelChange` guard, and `handleModelChange` (sends claude control `{subtype: "set_model", model}` — confirmed correct against the Agent SDK's `encode_set_model_request`). tugdeck's `protocol.ts` already had the `model_change` outbound and `DevControlSender.setModel`. tugcast's control feed is a transparent conduit (no new verb work). So this step is **frontend-only**: chip → button, picker sheet, slash command, wiring. No tugcode recompile or Rust change.
- **[D13] / [Q08] amended.** Those decisions framed every Z4B chip as indicator-only with the permission chip as the sole exception. Per direct user direction, the model chip is now the **second** interactive chip — it opens the shared picker on press, exactly like the permission chip opens its sheet. The chip is an *opener*, not an inline picker; the sheet remains the picker surface. Reconcile the D13/Q08 prose accordingly.
- **No optimistic chip update.** Unlike permission mode (which has no round-trip and so updates optimistically), the model chip reflects the new model on the next `system_metadata` round-trip per [D03] — avoids showing a raw `value` (e.g. `default`) before the labeled live model lands.

---

#### Step 3: Rate-limit chip in Z4B {#step-3}

> **SUPERSEDED — reverted in favor of [#step-3.5].** The Z4B chip was built and shipped (commit `3dfc2274`), then pulled. Two reasons surfaced in review: (1) **it isn't parity** — the Claude Code terminal exposes no usage/limit chrome and no `/usage` slash command; the documented place to check quota is the web console, so a persistent indicator is an *extension*, not parity; (2) **quota is account-global**, so a per-card chip would duplicate the same state across every open dev card. The replacement is a single **app-level caution banner** ([#step-3.5]), shown only when claude actually signals trouble. The chip, its per-card store binding, and `lib/rate-limit.ts` were removed; the **transport infra was kept** (tugcast `rate_limit_event` → SESSION_METADATA routing in `feeds/session_metadata.rs` + `feeds/agent_supervisor.rs`, and `protocol.ts` `RateLimitInfo` / `RateLimitEvent`) — [#step-3.5] consumes it. The task list below is the historical record of what was built.

**Depends on:** #step-1

**Commit:** `feat(dev-card): rate-limit chip surfaces subscription-quota state in Z4B` (shipped as `3dfc2274`, then reverted by [#step-3.5])

**References:** [D01] Z4B chrome anchor, [D04] SessionMetadataStore hub, [D06] protocol baseline, [Q02] rate-limit store shape, [Q13] RateLimitEvent strictness, Risk R04, [L22] store→DOM observers, [L06] appearance via CSS/DOM, (#z4b-chrome-layout)

**Artifacts:**
- New: `rate-limit-chip.tsx` + `rate-limit-chip.css`
- New: `lib/rate-limit.ts` (pure `formatResetCountdown` / `isRateLimitChipVisible` / `rateLimitSeverity` / `isRateLimitExhausted` / `rateLimitContent`) + `lib/__tests__/rate-limit.test.ts`
- Modified: `session-metadata-store.ts` adds `rateLimit: RateLimitInfo | null` field; `_applyPayload` (extracted from `_onFeedUpdate`) discriminates `rate_limit_event` and preserves `rateLimit` / `models` across a `system_metadata` replace; `_ingestPayloadForTest` test seam
- Modified: `protocol.ts` for `RateLimitInfo` + `RateLimitEvent` outbound IPC types (mirror tugcode's)
- Modified (NOT originally listed — required): `tugcast` supervisor must rewrap `rate_limit_event` off CODE_OUTPUT onto SESSION_METADATA, same as `system_metadata` / `session_capabilities` — the chip's metadata-feed source. `feeds/session_metadata.rs` adds `is_rate_limit_event`; `feeds/agent_supervisor.rs` adds a `LedgerEntry::latest_rate_limit` slot, a merger branch, and on-bind replay (in-memory only; matters most when hard rate-limited and unable to start a turn to refresh). 9af307fe only landed the tugcode→IPC passthrough, not this re-route.
- Modified: `test-surface.ts` routes SESSION_METADATA `ingestFrame` to `sessionMetadataStore._ingestPayloadForTest` (mirrors production feed routing)

**Tasks:**
- [x] Extend `SessionMetadataSnapshot` with `rateLimit`.
- [x] Add `RateLimitEvent` parser; integrate with `FeedStore` subscription on the metadata feed.
- [x] Implement `RateLimitChip` reading `rateLimit` via `useSyncExternalStore` per [L02] — structural data (status, resetsAt, isUsingOverage) drives React rendering. Render as a two-line `TugBadge` (`layout="label-top"`, `label="Limit"`, `size="sm"`) per [#step-0] / [D01].
- [x] Visibility predicate: hidden when `status === "allowed"` and `resetsAt > 60min`; visible otherwise. Render once on structural change, not every tick.
- [x] Role: `agent` at rest, escalating to `caution` (and `danger` for hard limits / overage) on alert states — the one Z4B chip whose role is state-driven rather than fixed.
- [x] Do NOT width-stabilize — the countdown reflows the chip as it ticks ("5h 23m" → "59m" → "rate-limited"), accepted per [R01].
- [x] Color / overage state via `data-status` and `data-overage` attributes on the chip root; CSS owns the color transitions per [L06]. No React state for color.
- [x] **Countdown text ticks via direct DOM mutation per [L22]** — NOT via React state. Implementation: `useLayoutEffect` mounts a `setInterval(60_000)` that reads the current `resetsAt` from a ref and writes `textContent` of the countdown `<span>` directly. The store subscription provides resetsAt as stable structural data; the tick-text update never re-enters React's render cycle. Cleanup the interval on unmount or when the chip becomes hidden.
- [x] Format helper `formatResetCountdown(resetsAt, now)` returns the text the DOM mutation writes (e.g. `"5h 23m"`); pure function, no side effects.

**Tests:**
- [x] Pure-logic: `formatResetCountdown(resetsAt, now)` for various offsets; visibility predicate for combinations. (`lib/__tests__/rate-limit.test.ts`)
- [x] Real-app: replay a fixture frame with `status: "warning"`, assert chip mounts; replay `status: "allowed"` with `resetsAt > 60min`, assert chip unmounts. (`at0095-rate-limit-chip.test.ts`)
- [x] Real-app: verify the chip does NOT re-render through React on tick. Implemented faster than the literal 5-minute commit-count window: the chip exposes a `__atRateLimitTick` hook + `__atRateLimitRenderCount` (both gated on `__tugTestMode`); the test fires one tick, asserts the countdown span's `textContent` was rewritten AND the render counter is unchanged — proving the tick is DOM-only.

**Checkpoint:**
- [x] `just app-test rate-limit-chip` → `VERDICT: PASS`

---

#### Step 3.5: App-level rate-limit caution banner {#step-3.5}

**Depends on:** #step-3 (consumes the transport infra it kept)

**Commit:** `feat(dev-card): app-level rate-limit caution banner`

**References:** [D24] app-level banner (this step), [Q02] rate-limit store shape (revised), [D18] strict shape, [Q13] strictness, Risk R04, [L06] appearance via CSS/DOM, (#strategy)

**Course-correction rationale.** Quota is **account-global** and the terminal has **no usage chrome**. So the right surface is one **transient, app-level** caution banner (not per-card, not a persistent indicator) that appears only when claude actually signals trouble — modeled exactly on the reconnection banner (`TugBannerProvider` in `components/chrome/tug-banner-bridge.tsx`), which is already the app-level, single-instance, connection-fed banner pattern. This **supersedes [Q02]/[D04]** for this surface: an account-global signal belongs in an app-level store, not the per-card `SessionMetadataStore` (the premise behind [Q02]'s "extend the per-card snapshot" was the per-card chip, which is gone).

**The data reality (confirmed from the CLI schema, drives the trigger).** The `rate_limit_event` payload is coarse — `{ status, resetsAt, rateLimitType, overageStatus, overageDisabledReason?, isUsingOverage }` — and carries **no "percent used"** (the web console's usage bars come from a different API). Rather than wait to capture a live limited payload (which means actually hitting a limit), the enum was read from the authoritative source — the Claude Code CLI's own zod schema (`v2.1.158` binary):

- `status: "allowed" | "allowed_warning" | "rejected"` — `allowed` = fine, `allowed_warning` = approaching, `rejected` = hard-limited (request refused; the terminal pops a blocking upgrade / extra-usage menu in this state).
- `rateLimitType: "five_hour" | "seven_day" | "seven_day_opus" | …`
- `overageStatus` mirrors that enum; the captured benign default is `overageStatus: "rejected"` + `overageDisabledReason: "org_level_disabled"` — the org-overage-off default, **NOT** an alert. The CLI only warns on overage when `isUsingOverage && overageStatus === "allowed_warning"` (its copy: "You're close to your usage limit").

So the trigger is grounded, not guessed: hidden on `status === "allowed"`; **approaching** (caution) on `status === "allowed_warning"` or the overage-close case; **limited** (danger) on `status === "rejected"`. `overageStatus` alone never escalates — this is exactly the bug that made the reverted chip paint red on a healthy session (it keyed danger off `overageStatus === "rejected"`, the benign default).

**Artifacts:**
- New: `lib/rate-limit-store.ts` — app-level singleton, constructed at deck-manager boot with the `TugConnection`, subscribing to the SESSION_METADATA feed and tracking the latest `rate_limit_event` across **all** sessions (account-global ⇒ most-recent is authoritative). `subscribe` / `getSnapshot` ([L02]) + an `_ingestForTest` seam.
- New: `lib/rate-limit.ts` (re-introduced, banner-shaped) — pure `rateLimitBannerState(info): "ok" | "approaching" | "limited"` (or `null`) + `formatResetCountdown(resetsAt, now)`; `lib/__tests__/rate-limit.test.ts`.
- New: `components/chrome/rate-limit-banner-bridge.tsx` — `RateLimitBannerProvider`, mirrors `TugBannerProvider` but L02-clean (`useSyncExternalStore` over the app-level store, not the bridge's `useState` + `useEffect`): always mounted, renders **one** `TugBanner` (`variant="status"`, `tone="caution"` for approaching / `"danger"` for limited).
- Modified: `deck-manager.ts` mounts `RateLimitBannerProvider` alongside `TugBannerProvider` (single instance for the whole deck).
- Modified: `test-surface.ts` adds an **app-level** (not card-scoped) ingest seam routing a `rate_limit_event` into the app-level store.
- Reused unchanged (kept from [#step-3]): tugcast `rate_limit_event` → SESSION_METADATA routing; `protocol.ts` `RateLimitInfo` / `RateLimitEvent`.

**Tasks:**
- [ ] `RateLimitStore` app-level singleton: subscribe to SESSION_METADATA at the connection level, keep the latest `rate_limit_event` payload (filter by `type`), expose `subscribe`/`getSnapshot` + `_ingestForTest`.
- [x] `rateLimitBannerState(info)` pure helper (grounded enum): `ok` when `status === "allowed"` && not overage-close; `approaching` on `status === "allowed_warning"` (or `isUsingOverage && overageStatus === "allowed_warning"`); `limited` on `status === "rejected"`. `overageStatus` alone never escalates.
- [x] `formatResetCountdown` pure helper (carried over).
- [x] `RateLimitStore` app-level singleton: own a `FeedStore` on SESSION_METADATA, keep the latest `rate_limit_event` payload (filter by `type`), expose `subscribe`/`getSnapshot` + `_ingestForTest`.
- [x] `RateLimitBannerProvider`, L02-clean: one `TugBanner` (`status`; `caution` approaching / `danger` limited), message e.g. `Approaching usage limit — resets in {countdown} · check usage at claude.ai`; visibility state-driven, auto-clears when the quota returns to `allowed`.
- [x] Mount once in `deck-manager.ts`. **No per-card surface** — the dedup is structural (one banner for the deck).
- [x] App-level test seam in `test-surface.ts` (`ingestRateLimit`).

**Tests:**
- [x] Pure-logic: `rateLimitBannerState` over the benign default (hidden), `allowed_warning` (approaching), `rejected` (limited), overage-close (approaching), and `overageStatus: "rejected"` alone (hidden); `formatResetCountdown` offsets.
- [x] Real-app: inject a benign `allowed`/`rejected` frame → **no banner**; inject `allowed_warning` → **one** banner with the reset countdown; `rejected` → **one** danger banner; return to `allowed` → banner clears.
- [x] Real-app **dedup**: open two dev cards, inject a warned frame → exactly **one** banner element in the deck (the bug this step exists to prevent).

**Checkpoint:**
- [x] `just app-test rate-limit-banner` → `VERDICT: PASS`

---

#### Step 4: Effort chip in Z4B {#step-4}

> **Re-targeted.** The original Step 4 ("session-state chip refinement" — mirror lifecycle states `new` / `streaming` / `awaiting-approval` / `interrupted` / `error` into the Z4B session chip) is **cancelled**: those lifecycle states are already surfaced in the dev-card **status bar** (the Z2 `STATE` instrument cell), so duplicating them in a Z4B chip is redundant. The existing Z4B session-id chip (`DevSessionIdBadge`, caption `SESSION`) is untouched. Step 4 is re-targeted to add the **effort chip** — reasoning-effort control, a genuine Claude Code feature (the terminal's `/effort` command) we do not yet surface.

**Depends on:** #step-2b (reuses the shared-picker + per-card-persistence patterns the `/model` picker established)

**Commit:** `feat(dev-card): effort chip + reasoning-effort control in Z4B`

**References:** [D01] Z4B chrome anchor, [D04] SessionMetadataStore hub, [D07] per-card persistence, [D13] (model/permission interactive-chip precedent), [R07] no live set verb, (#z4b-chrome-layout)

**What effort is (grounded in the CLI v2.1.158 binary).** `/effort` "controls how long Claude thinks before answering" — `high` for tricky bugs, `low` for quick edits, `xhigh`/`max` for the hardest tasks. The **live session effort enum is `low | medium | high | xhigh | max`**. It is **model-gated**: the `initialize` capabilities carry an `effort` support object (`{supported, low:{supported}, …, max:{supported}}`) *only when the current model supports reasoning effort*, plus a per-model `supportsEffort` flag (already on the wire `models[]` entries, currently dropped by tugcode's strict-shape parser — this step is the consumer that re-adds it). The current level is the CLI's `effortValue`, shown in the terminal as `Current model: … (effort: high)`.

**Key constraint — no live set verb ([R07]).** Unlike model and permission mode, which claude accepts as **live `control_request` subtypes** (`set_model` / `set_permission_mode`, confirmed present in the binary), there is **no `set_effort` control subtype** in 2.1.158 — the only control subtypes are `initialize`, `can_use_tool`, `set_permission_mode`, `set_model`. Effort is set **only** via the `--effort <level>` spawn flag (confirmed present). So a live effort change must **respawn claude with `--effort` + `--resume`**; the transcript survives via tugcast's resume/replay, but there is a brief reconnect — heavier than the model/permission chips' live round-trip. The button-chip UX is identical to model's; only the backend set path differs. (If a future claude adds a `set_effort` control verb, the backend swaps to a live request with no UI change.)

> **Decision (resolved 2026-05-30): build it as written.** The `effort_change` → respawn-with-`--resume` path is accepted: effort changes are infrequent and user-initiated, and the transcript is preserved via tugcast replay, so the brief reconnect is an acceptable cost for a real, interactive control. Chosen over a display-only chip (rejected — defeats the "button chip like model/permission" intent) and a defer-to-next-spawn set (rejected — weakest UX). Revisit only if a `set_effort` control verb lands (swap to live, no UI change) or the reconnect proves disruptive in practice ([R07] trigger).

**Artifacts:**
- New: `effort-chip.tsx` — Z4B interactive button chip, a two-line `TugPushButton` (`label-top` / `size="sm"` / `role="agent"`, caption `EFFORT`, value the level label e.g. `High`), mirroring `model-chip.tsx`. Press opens the shared effort picker. **Always present** (the Z4B cluster is a stable row, like Mode / Model). A model that supports effort always shows a level: the explicit override if set, else the effective **default** (`DEFAULT_EFFORT_LEVEL = "high"` — claude 2.1.158 *"now defaults to high effort"*, grounded in the binary; a fresh session genuinely runs at high). Support resolves from the live `initialize` capabilities for a new session, and — since a **resumed** session gets no `initialize` handshake — from the static `KNOWN_MODELS` fallback keyed on the replayed `system_metadata.model` (the same fallback the model chip uses), so a restored session repopulates rather than sitting at `-`. The `-` placeholder shows only for a model known NOT to support effort (per-model `supportsEffort` absent — e.g. haiku) or before anything is known (no caps AND no model); there the press is an inert no-op.
- New: `effort-picker-sheet.tsx` + `useEffortPicker` hook — the shared picker sheet (supported levels only, current marked), modeled on `model-picker-sheet.tsx` / `useModelPicker`. The chip press and a future `/effort` slash command both route to the one opener.
- New: `lib/effort.ts` — pure `EFFORT_LEVELS` order, `formatEffortLabel(level)`, `parsePersistedEffort`.
- Modified: `session-metadata-store.ts` adds `effort: string | null` (current level) and effort-support info (which levels are supported / whether the model supports effort), parsed from `session_capabilities`.
- Modified: `protocol.ts` adds the `effort_change` inbound IPC type (`{ type: "effort_change", effort: string }`).
- Modified: `tugcode` — `capabilities.ts` re-adds `supportsEffort` + the `effort` support map to the parsed capabilities; `session.ts` adds `--effort <level>` to spawn argv (alongside `--model` / `--permission-mode`) and an `effort` field on the spawn config; new inbound `effort_change` handler that **respawns with `--effort` + `--resume`** ([R07]); surfaces the current effort + support in `session_capabilities`.
- Modified: `dev-card.tsx` mounts `EffortChip` in the Z4B cluster (after the model chip); wires `useEffortPicker`.
- Modified: tugbank `dev.effort.<cardId>` namespace for per-card effort persistence ([D07]).

**Tasks:**
- [x] Pure helpers: `EFFORT_LEVELS = ["low","medium","high","xhigh","max"]`, `formatEffortLabel`, `parsePersistedEffort` (+ `orderEffortLevels`, `resolveEffortSupport`). Unit-tested (`lib/effort.ts`, `lib/__tests__/effort.test.ts`).
- [x] tugcode: re-added `supportsEffort` + `supportedEffortLevels` to `capabilities.ts`'s `parseModels`; `buildSessionCapabilities` surfaces the current effort (caller-supplied — `initialize` carries no current-effort field, so tugcode, the `--effort` owner, is the authority). `capabilities.test.ts` updated.
- [x] tugcode: `--effort` added to `buildClaudeArgs` + `effort` on `ClaudeSpawnConfig`; `Session.currentEffort` threaded through every (re)spawn (incl. fork/continue); inbound `effort_change` (`main.ts` dispatch + `handleEffortChange`) respawns claude with `--effort` + `--resume <sessionId>` (transcript preserved via tugcast replay) — no-op respawn when no live session id yet (level still recorded for the next spawn).
- [x] `SessionMetadataStore`: parses `effort` + per-model `supportsEffort` / `supportedEffortLevels` from `session_capabilities`; preserves both across the `system_metadata` replace; `applyEffort` optimistic update; exposed on the snapshot.
- [x] `EffortChip`: two-line `TugPushButton` reading `effort` + support via `useSyncExternalStore` ([L02]); **always present** (stable Z4B row) — shows the level when set+supported, else the `-` placeholder (unsupported / unknown / unset); press → shared picker (inert no-op when no supported levels). Width-stabilized per [R01] (own `effort-chip.css`).
- [x] `EffortPickerSheet` + `useEffortPicker`: the *active model's* `supportedEffortLevels` only (opus 5, sonnet 4 — captured live), current marked; confirm-style (OK/Enter) like the model picker since each commit respawns. `useEffort` hook owns `setEffort` → optimistic `applyEffort` + persist (`dev.effort.<cardId>`) + `effort_change`, plus capability-gated mount-restore ([D07]).
- [x] Mounted in Z4B after the model chip; picker opener shared (chip press + a future `/effort` command both route to `openEffortPicker`).

**Tests:**
- [x] Pure-logic: `formatEffortLabel` / `parsePersistedEffort` / `orderEffortLevels` / `resolveEffortSupport` (per-model gating + level bounds). 13 cases, all green.
- [x] Real-app (`at0096-effort-chip.test.ts`): chip present from mount showing `-` (no caps yet); inject `session_capabilities` with effort support → chip shows `High`; open picker (5 opus levels, current selected) → pick `Max` + OK → chip updates optimistically to `Max` (width stable); inject capabilities WITHOUT effort support → chip stays present, falls back to `-`. Driven via the new `ingestSessionMetadata` surface seam (the chip reads its own `SESSION_METADATA` FeedStore, unreachable by `driveDevSession`); synthetic clicks since the chip sits below the test window's CGEvent-clickable edge.
- [~] Real-app: the `effort_change` **respawn-with-resume** round-trip ([R07]) preserves the transcript — **integration-level** (needs a live tugcode + claude). Out of this UI test's reach; the optimistic chip update (the observable client-side effect of the set path) is covered above, and the respawn is verified at the Phase A checkpoint ([#step-5]) / live runs. The set path is wired end-to-end (chip → `setEffort` → `effort_change` frame → tugcode respawn).

**Checkpoint:**
- [x] `just app-test effort-chip` — **VERDICT: PASS** (1/1 files, 8 expects).

---

#### Step 5: Phase A Integration Checkpoint {#step-5}

**Depends on:** #step-0, #step-1, #step-2, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** [D01], [D04], [D24] rate-limit is an app banner, Spec S02 two-line TugBadge, (#success-criteria, #z4b-chrome-layout)

> **Composition note.** Phase A's Z4B chrome settled as: the existing route / project / session-id chips, plus the three interactive chips — **permission-mode**, **model**, **effort**. Two original items moved off Z4B: the rate-limit **chip** became an app-level **banner** ([#step-3.5], [D24]), and session-state refinement was cancelled (lifecycle lives in the status bar). The [D13] "indicator-only" stance was superseded for permission/model/effort, which are interactive (chip press / `Shift+Tab` open a picker or cycle).

> **Closed out 2026-05-30 — verified by running the real app**, not a synthetic harness pass. The full Z4B cluster (Claude Code / Project / Session / Mode / Model / Effort) renders and behaves correctly against a live claude 2.1.158 session (see screenshots): the two-line chips share the badge typography, the cluster fits without overflow, `Shift+Tab` cycles the mode, the model + effort chips open their pickers, effort shows the live `High` default and persists per card, and the rate-limit banner is its own app-level surface. Each underlying capability has its own app-test ([#step-0] `at0087`, [#step-1] `at0088`, [#step-3.5] `at0095`, [#step-4] `at0096`); a duplicate `z4b-phase-a-integration` harness pass would be redundant ceremony over behavior the live app already demonstrates.

**Tasks:**
- [x] Z4B cluster populates on a freshly-created card (route, project, session, permission-mode, model, effort) — verified live.
- [x] Chips render via the two-line `label-top` / `size="sm"` / `role="agent"` config; caption line matches the status-bar / badge legend typography (the label-colour fix landed in `6b762a05`).
- [x] Chip cluster fits within representative card widths without horizontal overflow — verified live.
- [x] `Shift+Tab` cycles permission mode through all four modes; chip updates each time (`at0088`).
- [x] Model chip press opens the `/model` picker ([#step-2b]) and updates after a `model_change`.
- [x] Effort chip shows the live level (default `High` when unset+supported), its picker sets the level (respawn-resume per [R07]), and it falls back to `-` only on a non-supporting model ([#step-4] `at0096`).
- [x] App-level rate-limit **banner** ([#step-3.5]) appears on a warned quota and clears on recovery — one banner for the deck (`at0095`).
- [x] Per-card persistence per [D07]: mode + effort restore on reopen (incl. resumed sessions, `46c88167`).
- [x] Drift regression clean (capabilities parser additions covered by `capabilities.test.ts`).

**Tests:**
- [x] Covered by the per-capability app-tests (`at0087` / `at0088` / `at0095` / `at0096`) + the live app run — no separate duplicate harness pass.

**Checkpoint:**
- [x] Verified by running the real app (live claude 2.1.158 session).

---

#### Step 6: `SessionPickerSheet` overlay primitive {#step-6}

> **✅ ALREADY DONE.** The session-picker capability ships as `dev-picker-cells.tsx` (the `session-resume` rows used by the cold-boot / empty-card chooser): an overlay sheet with `TugListView` rows, keyboard navigation (arrow + Enter + wrap), dismiss, and focus restore — i.e. everything the generic `SessionPickerSheet<TRow>` primitive was specced to provide ([D05]/[D15]). We did **not** need to build the separate generic primitive; `/rewind` ([#step-7]) and `/resume` ([#step-8]) build on the existing picker. Original detail removed — see git history for the superseded spec.

---

#### Step 7a: Empirical capture of terminal `/rewind` behavior {#step-7a}

**Depends on:** #step-5

**Commit:** `test(tugcast): probe terminal /rewind wire shape; re-baseline golden catalog to claude 2.1.158`

**References:** [D06] protocol baseline, [D10] rewind matches terminal, Risk R03, (#rewind-flow), (transport-exploration.md#rewind-empirical-capture-2158)

**Artifacts:**
- New: probe `test-36-slash-rewind` in `tugrust/crates/tugcast/tests/common/probes.rs` driving `/rewind` over stream-json
- New: full golden baseline `v2.1.158/` (36 probes incl. rewind) pinning the canonical event sequence; `capabilities/2.1.158/` + `capabilities/LATEST` advanced
- Updated: `dash/transport-exploration.md` adds the empirical findings of what terminal `/rewind` actually does on the wire

**Tasks:**
- [x] Run `/rewind` over stream-json (the only path tugcode drives) against a real `claude 2.1.158` session; capture the output. **Finding: it bounces — synthetic turn (`model:"<synthetic>"`, `num_turns:0`, `$0`), text `"/rewind isn't available in this environment."`**
- [x] Identify what the terminal sends / harness mutates / claude emits. **Finding: `/rewind` is NOT a wire verb. The terminal's rewind is client-side (truncate the `parentUuid`-chained session JSONL + restore checkpoints + `--resume`, same `session_id`). `--resume` reconstructs state purely from the JSONL (verified cross-process).**
- [x] Add `test-36-slash-rewind` to the probe table with the canonical input + expected event sequence.
- [x] Run `just capture-capabilities` to bake the fixture. **(Binary moved to 2.1.158 → full re-baseline of all 36 probes.)**
- [x] Document the findings in `transport-exploration.md` ([#rewind-empirical-capture-2158](transport-exploration.md#rewind-empirical-capture-2158)).

**Tests:**
- [x] Real-claude probe via `capture_all_probes` — 36/36 captured in 124s; `test-36-slash-rewind` PASS (10 events).
- [x] Drift regression clean — 0 failures, 3 Benign-class warnings (test-05/09 `assistant_text`↔`tool_activity` reorder; test-06 gained `rate_limit_event`).

**Checkpoint:**
- [x] `just capture-capabilities` — drift clean; `test-36-slash-rewind` present in `v2.1.158/`. (Recipe's auto-commit declined per git policy; files staged for the user to commit.)

**Findings (final — 2026-05-30, after full empirical verification).** What began as "capture the `/rewind` wire shape" became a complete reverse-engineering of how rewind works, driven by the terminal screenshots and live probes against `claude 2.1.158`. The bounce-probe tasks above stand; the settled results are:

- **Complete stdin input surface** (enumerated from the binary, not sampled): exactly **5 message types** — `user`, `bash_command`, `control_request`, `assistant`, `system` (anything else → "Ignoring unknown message type") — plus **43 `control_request` subtypes**. The only rewind-relevant verb is **`rewind_files`**. There is **no** `rewind_conversation`, `compact`, or `summarize` verb, and the `initialize` control request accepts no client-supplied conversation history (`initialMessages` is populated internally from the resumed JSONL only).
- **Typed `/rewind` bounces** — synthetic turn `"/rewind isn't available in this environment."` (`model:"<synthetic>"`, `num_turns:0`, `$0`). It is a client-rendered TUI command; the typed string never reaches a handler. Pinned as `test-36-slash-rewind`.
- **`/rewind` has two dimensions** (terminal UX, from the screenshots): a **turn picker** (per-turn code diff-stat, `(current)` marker, a reachability limit) → a **confirm sheet** whose options are conditional on `canRewind` for the picked turn: `Restore code and conversation` · `Restore conversation` · `Summarize from here` · `Summarize up to here` · `Never mind`.

**The four shippable mechanisms — all verified live this session:**
1. **Diff-stat preview** → `rewind_files{dry_run:true}` → `{canRewind, filesChanged, insertions, deletions}`. ✅ (live)
2. **Restore code** → `rewind_files{dry_run:false}` → reverts files claude edited via Edit/Write (verified: a written file was deleted). ✅ (live) — both require `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`, now set in `spawnClaude`. Protocol + fixture: [#rewind-files-control-request](transport-exploration.md#rewind-files-control-request), [`rewind-files.v2.1.158.json`](../tugrust/crates/tugcast/tests/fixtures/control-requests/rewind-files.v2.1.158.json).
3. **Restore conversation** → **truncate the session JSONL to the chosen turn boundary + `--resume`** (same `session_id`). ✅ (live: a 3-turn session chopped to 2 turns resumed cleanly and forgot the dropped turn — no artifacts, no re-responses). The JSONL *is* the conversation (the model API is stateless; claude rebuilds context from the file each turn), so removing tail records yields a shorter history with nothing to "detect." **Constraints:** cut at a clean turn boundary; **do not chop across a `/compact` boundary** (compaction rewrites the resume pointers → "No conversation found"); hand-authored or new-session-id transcripts are rejected — only tail-truncation of a registered, non-compacted session works.
4. **Never mind** → client-side cancel. ✅

**Summarize (from/up to here) — DEFERRED (out of scope for the dev-card `/rewind`).** It is claude's in-process **compaction engine** (`SXK`/`yXK`), invoked by the TUI over a message *slice*; it makes a real model call and persists an `is_compact_summary` user message. There is **no wire verb** for scoped compaction — `/compact` is whole-conversation with an auto-chosen boundary — so faithful reproduction would need a chop→`/compact`→re-append splice whose final step is unverified. Product decision (2026-05-30): leave it out; revisit only if claude ships an anchored-compact control verb (the natural sibling of `rewind_files`).

This re-specced [#step-7] around the four verified mechanisms and retired the `SessionPickerSheet` framing for `/rewind` ([D05] now applies to `/resume` only). The `rewind_files`-**through-tugcode** probe is deferred to [#step-7] (needs the bridge IPC path).

---

#### Step 7b: `/rewind` — turn picker + restore code/conversation {#step-7}

**Depends on:** #step-1c, #step-7a

**References:** [D05] sheet-not-shared, [D06] protocol baseline, [D10] rewind matches terminal, [D15] overlays, [L23] preserve user-visible state, [L26] stable mount identity, Risk R03, Spec S01, (#rewind-flow), (transport-exploration.md#rewind-files-control-request)

> **Re-specced (2026-05-30, post-[#step-7a]).** Grounded entirely in the [#step-7a] live verification. Two framing corrections from the original: (1) `/rewind` is **not** a `SessionPickerSheet` consumer — that primitive (absorbed into `dev-picker-cells.tsx`) lists *distinct sessions* for `/resume`; `/rewind` lists *the current session's own turns*. They share only "overlay with a list." [D05]'s shared-primitive idea is **retired for `/rewind`**. (2) `/rewind` has **two independent dimensions** — restore conversation and/or restore code — with **separate, both-verified wire mechanisms**: code = the `rewind_files` control request; conversation = JSONL truncation + `--resume`. **Summarize is deferred** (see below).

**Scope: the four verified mechanisms ([#step-7a]).** Diff-stat preview (`rewind_files{dry_run:true}`), restore code (`rewind_files{dry_run:false}`), restore conversation (truncate session JSONL + `--resume`), and cancel. **Summarize from/up to here is OUT OF SCOPE** — no wire verb exists (it's in-process compaction); revisit only if claude ships an anchored-compact verb. So the confirm sheet has **three** actions, not five.

**The flow (see re-specced [S01](#s01-rewind-flow)).**
- **Picker** over the current session's user messages, most-recent first. Each row: timestamp, preview, and a **code diff-stat badge** (`+N −M`, or "No code changes") from a `rewind_files{dry_run:true}` per turn; `(current)` marks the live tip.
- **Confirm sheet** after a pick — options **conditional on `canRewind`** for that turn: `Restore code and conversation` (only when `canRewind:true`) · `Restore conversation` (always) · `Never mind`.
- **Reachability limit:** a turn whose checkpoint has aged out returns `canRewind:false` → code restore shown unavailable (not hidden); conversation restore still works.

**Deferred — Summarize from/up to here.** No wire verb for scoped compaction in `claude 2.1.158` (it's the in-process `SXK` engine; `/compact` is whole-conversation, auto-boundary — [#step-7a]). The two Summarize rows are **omitted** from the dev-card confirm sheet (not shipped-disabled). Revisit if claude exposes an anchored-compact control verb; the reconstruction-via-`/compact` path is recorded in [#step-7a] / git history if we ever choose to approximate it.

**Anchor — the rewind target (additive design, confirmed live in [#step-7a]).** The anchor is claude's **user-prompt-record `uuid`** — the value `rewind_files.user_message_id` takes AND the JSONL truncation boundary. **It is NOT the dev-card's `msgId`** (that is claude's *assistant* `message.id`; the user opener carries no `msg_id` on the wire — verified). It IS, however, **already on the wire**: every user message claude echoes back under `--replay-user-messages` carries a `uuid` field, verified *equal* to the JSONL prompt-record uuid — currently received-but-ignored. We surface it **additively, without touching `msgId` / `turnKey` / the reducer keying** (the hard-won id model is unchanged — one new field, one clear purpose, not an overload):

- **tugcode** captures the prompt `uuid` from the user-echo event and surfaces it **additively**, by two complementary paths (implemented in [#step-7-1]): (a) the **replay / mid-turn-snapshot** paths — which already emit `add_user_message` — gain a new OPTIONAL field `promptUuid?` (replay reads it from the JSONL `user` record's `uuid`; the snapshot from the captured echo); (b) the **steady-state live** path — which emits NO `add_user_message` (the dev-card minted the turn locally at `handleSend`) — gets a dedicated `prompt_anchor {promptUuid}` frame, since a live `add_user_message` would duplicate-mint the turn. Both are purely additive; existing frames/consumers are unaffected and `msgId`/`turnKey`/keying are untouched. (The original single-frame plan assumed `add_user_message` rode the live path too; it does not — hence the split.)
- **dev-card** stores `promptUuid` as a new optional field on the opening user `Message`; the rewind IPC sends it back. The anchor travels with the turn and survives resume (the replayed `user_message` frame carries it, since the JSONL record has the uuid).
- **Resume / cold-boot:** recovered for free from the replayed frames; belt-and-suspenders fallback — tugcode can derive it by walking the stored assistant `msgId` record's `parentUuid` chain (skipping tool_result / `attachment` records) to the prompt record. Verified through a tool-use turn ([#step-7a]).
- **Alternative considered (A'):** keep the prompt uuid only in a per-session tugcode map and have the dev-card send the existing `msgId` (zero new stored field, but adds tugcode state + rebuild logic). **Chose the optional field** for explicitness and to avoid a stateful map; revisit only if implementation surfaces a reason.

> **Broken into three sub-steps (2026-05-30)** along the proven/independent seams from [#step-7a]: the two backend mechanisms I verified separately become two tugcode sub-steps; the UI that ties them sits on top. **7b.1 and 7b.2 are independent** (either order); **7b.3 consumes both.** Each is independently shippable with its own checkpoint.

##### Step 7b.1: `rewind_files` bridge — code restore + diff-stat preview (tugcode) {#step-7-1}

**Depends on:** #step-7a · **Commit:** `feat(tugcode): rewind_files control-request bridge`

**References:** [D06] protocol baseline, [#step-7a], (transport-exploration.md#rewind-files-control-request)

**Not new plumbing — reuse the `initialize` pattern.** tugcode *already* sends client→claude control requests (the `initialize` handshake at spawn) and reads their `control_response` (the capabilities parse), via `control.ts`'s `sendControlRequest` + the `pendingControlRequests`/`request_id` correlation (validated against `tugcode/src/{control,session}.ts` in the [#step-7a] review). `rewind_files` is a **new subtype on existing rails**, not a new direction — lower risk than first thought. Send `control_request{subtype:"rewind_files", user_message_id:<promptUuid>, dry_run}`, correlate the `control_response`, surface as IPC.

**Artifacts:**
- tugcode: `rewind_files` control-request send + `control_response` correlation (the [#step-7a] envelope; `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` already set in `spawnClaude`).
- **Anchor capture (additive — see umbrella):** capture the prompt `uuid` from the user-echo event (`routeTopLevelEvent`'s `case "user"`, submission-echo only — not tool-result `user` events) and surface it on the optional `promptUuid?` of `add_user_message` (replay + mid-turn snapshot) AND on a new live-path `prompt_anchor {promptUuid}` frame (steady-state live emits no `add_user_message`). `msgId`/`turnKey`/reducer keying untouched.
- New inbound IPC `rewind_preview` `{type:"rewind_preview", promptUuid}` → `rewind_files{dry_run:true, user_message_id:promptUuid}` → outbound `rewind_preview_result` `{promptUuid, canRewind, filesChanged?, insertions?, deletions?}`.
- `session_rewind` **code branch** (`scope:"code"|"both"`) → `rewind_files{dry_run:false, user_message_id:promptUuid}` → outbound ack. (The `conversation` branch lands in [#step-7-2].)
- `protocol.ts` + `tugcode/src/types.ts` gain these types; pin against a fixture per [D06].

**Tasks:**
- [x] tugcode: capture the prompt `uuid` from the user-echo event → `promptUuid?` on `add_user_message` (replay + snapshot) + a live-path `prompt_anchor` frame (`routeTopLevelEvent` surfaces `promptUuid`; `dispatchEventToTurn` latches `ActiveTurn.promptUuid` + emits `prompt_anchor`; `replay.ts` reads `entry.uuid`).
- [x] tugcode: send the `rewind_files` control request and correlate its `control_response` (`pendingRewindRequests` map + `tryHandleRewindControlResponse`, caught turn-free in `handleClaudeLine` exactly like the `initialize` handshake); map to/from the new IPC.
- [x] `rewind_preview` → dry-run → `rewind_preview_result` outbound (`handleRewindPreview`).
- [x] `session_rewind{scope:"code"}` (+ the code half of `"both"`) → apply → `rewind_result` ack (`handleSessionRewind`; `scope:"conversation"` is the [#step-7-2] seam — issues no control request).
- [x] **Idle gating:** `rewind_files` requires claude idle (`isClaudeIdle`). tugcode rejects a `rewind_preview`/`session_rewind` mid-turn with a `canRewind:false`+busy-error result; the sheet ([#step-7-3]) reflects it. *(Claude's own mid-turn `rewind_files` behavior is confirmed by the live probe.)*
- [x] Probe-table entry (`test-37-rewind-files-roundtrip`) driving the round-trip **through tugcode** (Write a file → capture `prompt_anchor` uuid → dry-run `rewind_preview_result` → apply `rewind_result` + file reverted), matching the [#step-7a] fixture. New `ProbeMsg::RewindPreview`/`SessionRewind`, `TestWs::send_rewind_*`, runtime `promptUuid` capture, and `collect_code_output_until` (the round-trip ends past `turn_complete` on `rewind_result`).

**N+1 note (informs [#step-7-3]'s consumption).** The TUI reads in-process `fileHistory` for free; over the bridge each row's diff stat is a `rewind_files{dry_run}` round-trip. The sheet must fetch **lazily — visible/focused rows only, cached** — never fire one per turn on open. The bridge supports on-demand single-anchor queries; the batching discipline lives in 7b.3.

**Tests:**
- [x] tugcode unit (`bun test`): control-request correlation + IPC mapping; `promptUuid` capture (`src/__tests__/rewind-bridge.test.ts`, 15 tests).
- [x] Real-claude probe through tugcode (`test-37`) **PASSED live** under `capture_all_probes` (claude 2.1.158, events=29): Write → `prompt_anchor` → `turn_complete` → `rewind_preview_result{canRewind:true, deletions:1, insertions:0}` → `rewind_result{canRewind:true, scope:code}`, matching `rewind-files.v2.1.158.json`. Golden committed (`b1e4c122`).

**Checkpoint:**
- [x] Rebuild tugcode (`bun build --compile`) — done; `cd tugcode && bun test` green (516 pass); the through-tugcode probe present + **passing live under `capture_all_probes`** (golden `test-37-rewind-files-roundtrip.jsonl`; the catalog refresh also folded `prompt_anchor` into every live-turn sequence). `cargo nextest -p tugcast`: 664 pass.
- [x] **Drift regression clean** (`stream_json_catalog_drift_regression`, live v2.1.158): **0 failures**, 5 benign warnings. It first surfaced `prompt_anchor` as `ReorderedSequence` FAILs (test-14, test-23) — its emit races the first assistant stream events, so its stream position is non-deterministic (same class as `rate_limit_event`). Fixed by classifying `prompt_anchor` as a position-exempt `INTERSTITIAL_EVENT_TYPE` (`797a1220`); the reducer attaches `promptUuid` to the active turn regardless of position. Also fixed the `just capture-capabilities` recipe, which `set -e`-aborted at an interactive `read` before the drift leg in a non-TTY shell (`c2f2cda7`). *(One residual benign WARN: `test-16-model-change-roundtrip` flaked during the capture run and was restored to its pre-7b.1 golden, so its sequence lacks `prompt_anchor` until the next clean full capture — pre-existing probe flakiness, unrelated to 7b.1.)*

##### Step 7b.2: conversation rewind — JSONL truncate + `--resume` (tugcode) {#step-7-2}

**Depends on:** #step-7a (independent of [#step-7-1]) · **Commit:** `feat(tugcode): conversation rewind via JSONL truncate + --resume`

**References:** [D06] protocol baseline, [#step-7a] (the chop verification is the spec), [R07] respawn pattern

**The [L26]-safe model — SILENT respawn, NOT replay-rebuild.** This is the crux the review surfaced. A respawn-with-`--resume` normally triggers a **replay**, which re-mints turn identity (`turnKey` is minted at `handleSend`, not on replay; replay synthesizes `u-<n>` ids) → every surviving row would remount → **[L26] violated wholesale** (scroll/selection lost on the turns the user *kept*). So conversation rewind is **NOT** a replay rebuild. Instead:
- The **UI truncates its store locally** ([#step-7-3]) — survivors keep their existing `turnKey`/`msgId`, so React preserves their mounts.
- tugcode does a **silent respawn**: truncate the JSONL + respawn `--resume` purely to load the rewound context for the **next** turn, **suppressing the replay emit** (reuse the effort-change silent-respawn shape — [R07] — which already respawns without re-emitting the transcript). The respawn changes claude's loaded context; it does **not** rebuild the dev-card transcript.

**Artifacts:**
- tugcode: on `session_rewind{scope:"conversation"|"both"}`, locate the session JSONL (`~/.claude/projects/<slug>/<sid>.jsonl` — derivation already exists), **truncate to the record before the `promptUuid` record** (clean turn boundary), then silent-respawn (above).
- **Fork is the default** (matches the terminal's "the conversation will be forked"): a registered copy of the *truncated* history under a fresh claude session id, resumed in place of the original, with the card **rebound to the fork's session-id**. **The rebind MUST persist** through the card→session binding (`cardSessionBindingStore` / `dev-session-restore.ts`) — otherwise cold-boot resumes the *original* untruncated session and the rewind silently reverts on reload (verified: the transcript restores by replaying the bound session's JSONL). In-place truncation (`--resume` same id, destructive — drops the tail permanently) is the **opt-in** variant; same sid, so no binding change, cold-boot-consistent already.
  - **Fork mechanism — empirical correction (2026-05-31, claude 2.1.158).** The original plan said "`--fork-session` mints a registered copy, truncate+resume the *copy*." Two live findings reshaped this: (1) in stream-json mode claude emits **no `system:init` (and no fork file) until first input** — so `--fork-session` cannot materialize a copy to truncate *before* the next turn, and the fork's new id can't be learned without spending a turn; (2) a **byte-for-byte copy of a real registered session under a new id IS resumable** via `--resume <newid>` (the [#step-7a] "new-session-id transcripts are rejected" finding applied to *hand-authored* transcripts, not copies of real sessions). So the implemented fork is: **copy the truncated history to a freshly-minted id on disk, then silent-respawn `--resume <newid>`** — no `--fork-session` flag. The new id is known synchronously (we mint it), so the `rewind_result.newSessionId` ack + the synthetic `session_init` rebind don't depend on claude's deferred init. Same end state (registered fork, original preserved, card rebound), simpler and race-free. (Verified live: a 2-turn session forked to turn 1 resumed cleanly and recalled only the retained turn; the original session id was untouched.)
- **`scope:"both"` order (code restore, then fork):** run `rewind_files{dry_run:false}` on the **live** session first — it reverts the working-directory files (session-independent) using the live session's `fileHistory` — *then* fork the conversation. Forking first risks running `rewind_files` against a fork whose `fileHistory` carriage is unverified. **Confirm this composition with a probe during implementation** (fork + code-restore is the one untested interaction from [#step-7a]).
- **Compaction-boundary guard:** if a `compact_boundary` sits between the target turn and the tip, refuse / snap to the nearest safe boundary (chopping past a compaction breaks `--resume` → "No conversation found" — [#step-7a] constraint). Never silently corrupt the session.
- **Concurrency safety:** truncate the JSONL **only while the claude subprocess is down** (between `killAndCleanup` and the resume spawn) so there's no write race against claude; for the destructive in-place variant, snapshot the pre-truncation tail first so a failed respawn can roll back.
- Reuses the [R07] respawn machinery (`killAndCleanup` + `spawnClaude` resume) from the effort change.
- Outbound: an ack (and, for fork, the new session-id for the card rebind). **No transcript re-emit.**

**Tasks:**
- [x] JSONL truncation keyed on the `promptUuid` record at a clean turn boundary. (`computeConversationTruncation` — pure helper; `slice(0, boundary)` keeps every record before the anchor's user-prompt record.)
- [x] Silent respawn (`--resume`) with replay-emit suppressed; fork path (copy truncated history to a fresh id → `--resume <newid>` → emit new session-id for rebind — *not* `--fork-session`, per the empirical correction above).
- [x] **Fork rebind persists** the new session-id — tugcode sets `resumeSessionId = newId`, emits `rewind_result.newSessionId` **and** a synthetic `session_init(newId)` (which tugcast persists as `claude_session_id` → cold-boot resumes the fork). The `cardSessionBindingStore` / `dev-session-restore.ts` consumption is [#step-7-3].
- [x] **`scope:"both"` order:** code-restore on the live session first, then fork (a failed code restore aborts before the conversation leg — no partial). Composition probed live: `test-39-rewind-both-composition` (`canRewind:true`, code revert + fork's `newSessionId`).
- [x] Compaction-boundary guard. (`compute…` returns `compaction_blocked` for an `isCompactSummary` user record or `subtype:"compact_boundary"` system record in the chop range → `rewind_result{canRewind:false}`, never a corrupt resume.)
- [x] Concurrency: truncate only while the subprocess is down (`killAndCleanup` precedes any write); the in-place variant keeps the full pre-truncation bytes and rolls back on respawn failure.
- [x] Emit ack / new-session-id outbound (no transcript rebuild).

**Tests:**
- [x] Real-claude probe through tugcode: multi-turn session → `session_rewind{scope:"conversation"}` → forks + resumes (`test-38-rewind-conversation-fork`, PASS, `canRewind:true` + `newSessionId` + fork `session_init`). The "recalls only the retained turns" semantics were verified directly against claude during implementation (the chop experiment: a 2-turn session forked to turn 1 recalled only turn 1).
- [x] Guard test: a rewind target across a compaction boundary is refused, **not** "No conversation found". (`rewind-bridge.test.ts` — both compaction-marker shapes; refuses before any kill/truncate/respawn.)
- [x] **Silent-respawn assertion:** the respawn emits **no** replay/transcript events (only the rebind `session_init` + the ack) — the precondition for [#step-7-3]'s [L26] correctness. (`rewind-bridge.test.ts`.)
- [~] **Fork cold-boot:** tugcode emits the fork id via `session_init` + `rewind_result.newSessionId`; the *persisted-binding* cold-boot assertion (binding points at the fork, cold-boot resumes the truncated fork) lands with the `cardSessionBindingStore` wiring in [#step-7-3].
- [x] **Composition probe:** `scope:"both"` reverts a file claude edited **and** forks the conversation — `test-39-rewind-both-composition` (confirms code-restore-then-fork order against real claude).

**Checkpoint:**
- [x] Rebuild tugcode; the three real-claude probes (`test-38`/`39`/`40`) present + passing under `capture_all_probes` (40/40 captured); drift regression clean (0 failures, 4 benign `OptionalSequenceVariance` WARNs on pre-existing probes test-05/21/22/26 — assistant_text leading-narration variance, not the new probes). Golden re-baselined to v2.1.158.

##### Step 7b.3: `RewindSheet` — turn picker + restore confirm (tugdeck) {#step-7-3}

**Depends on:** #step-1c, #step-7-1, #step-7-2 · **Commit:** `feat(dev-card): /rewind sheet — turn picker + restore confirm`

**References:** [D05] sheet-not-shared, [D15] overlays, [L02] external state via store, [L23] preserve user-visible state, [L26] stable mount identity, Spec S01, (#rewind-flow)

**Artifacts:**
- New: `rewind-turn-source.ts` — projection over `code-session-store.transcript` → picker rows carrying the turn's **`promptUuid`** (the anchor, the new optional field from [#step-7-1] — *not* `msgId`), preview, timestamp, diff-stat. **Not** a `SessionPickerSheet` data source.
- New: `RewindSheet` (card-scoped overlay per [D15]) — picker step + confirm step with the **three** conditional actions. Its picker `TugListView` uses a **module-constant `cellRenderers`** (like `RECENTS_CELL_RENDERERS`/`SESSIONS_CELL_RENDERERS`) — never inline renderer lambdas — so picker rows stay [L26]-stable.
- Modified: register `/rewind` in the [#step-1c] registry; `RUN_SLASH_COMMAND` opens `RewindSheet`.
- Modified: `code-session-store/` reducer — a **local conversation-truncation** transition (drop turns after the anchor; survivors keep `turnKey`/`msgId` untouched). This is the source of truth for the post-rewind transcript; 7b.2's respawn is silent (no replay rebuild).

**Tasks:**
- [x] `rewind-turn-source.ts` projection; rows carry `promptUuid`; per-row diff-stat filled **lazily** (fetched on row **focus** in the sheet, cached in the store snapshot's `rewindPreviews`, read via `useSyncExternalStore`) from `rewind_preview{promptUuid}` → `rewind_preview_result` ([#step-7-1]) — never one fetch per turn on open. The projection excludes the first targetable turn (rewinding to it would empty the session).
- [x] `RewindSheet`: picker → confirm (three conditional actions — code option shown only when the turn's diff-stat reports a restorable checkpoint); Enter confirms, ESC dismisses (TugSheet); card-scoped overlay ([D15]). Restore actions disabled while claude is busy (idle gate, mirrored from [#step-7-1]; tugcode enforces it authoritatively).
- [x] Wire `code` / `conversation` / `both` through `session_rewind{promptUuid, scope, fork}` (`codeSessionStore.sessionRewind`, fork:true default); dismiss on the `rewind_result` ack, surface the error + allow retry on failure. **Fork rebind persists via the existing `session_init` → tugcast → tugbank path** (tugcode's synthetic `session_init(newId)` from [#step-7-2]; same plumbing `/fork` uses — the card keeps working on the stable `tugSessionId`, cold-boot reads the persisted fork id). *(Live cold-boot confirmation is the deferred app-test below.)*
- [x] Empty-state: a 0- or 1-(anchored-)turn session does not surface `/rewind` in the popup (`canOfferRewind` gate on the local-command completion provider).
- [x] **[L26] mount identity — via LOCAL truncation, not replay.** `truncateTranscriptAtAnchor` returns the prefix before the anchor; survivors are the **same `TurnEntry` references** (key/`msgId` byte-identical). One phase-branching sheet body (no component-type swap across picker/confirm); picker rows reconcile through a module-constant `REWIND_CELL_RENDERERS` (no inline lambdas). Driven by a `truncate-transcript` effect on the `rewind_result` ack (7b.2 respawns silently — no replay to re-mint keys). All three identity inputs audited together.

**Tests:**
- [x] Pure-logic: turn-source projection (row count, ordering, `promptUuid` carriage, first-turn exclusion, empty-state gate — 10 tests); reducer truncation preserves pre-rewind row references verbatim + anchor capture (both paths) + preview fold + ack/truncation gating (15 tests). All green.
- [x] Real-app (`at0097-rewind-sheet`): a deterministic 3-turn session (driven via `driveDevSession`/`ingestFrame`, no live claude) → open `/rewind` through the real submit path → the picker lists the two valid targets → pick the last turn → "Restore conversation" → inject the `rewind_result` ack → the transcript truncates locally (picked turn dropped, earlier turns kept) and the sheet dismisses. *(Code-restore's real file revert stays pinned at the tugcode layer — test-37/test-39 probes — since the store-only harness has no live backend file.)*
- [x] **Real-app L26 pin (`at0098-rewind-mount-identity`):** select text in a surviving (pre-rewind) turn, scroll to a non-zero offset, rewind a LATER turn → the **selection survives** (the definitive no-remount proof — a remount collapses it) and scroll is **not clamped to 0**. *(Finding: scroll settles at the new bottom because the list's `followBottom` re-anchors to the retained tip after the drop — scroll POLICY, distinct from the L26 no-remount guarantee the selection pins. The test asserts no-clamp-to-0, not byte-exact scroll.)*

**Checkpoint:**
- [x] `just app-test rewind-sheet` → PASS (`at0097-rewind-sheet.test.ts`).
- [x] `just app-test rewind-mount-identity` → PASS (`at0098-rewind-mount-identity.test.ts`).

> **Polish (2026-05-31).** Post-review pass on the sheet + history: the `RewindSheet` is now a **single wide step** (no picker→confirm view swap) — a turn list rendered with the `/resume` session-option visual above an inline `TugChoiceGroup` for the restore scope (Conversation / Code + conversation, the code segment enabled only when the selected turn has a restorable checkpoint), with **Cancel / Rewind** at the bottom (Rewind the Enter default, right of Cancel). The `TugChoiceGroup` selection is captured via a `useResponderForm` `selectValue` binding ([L11]). And a conversation/both rewind now **rewinds the prompt history too**: a dev-card effect, keyed on the `rewind_result` ack, truncates the stable-`tugSessionId`-keyed `PromptHistoryStore` to the retained user-prompt count (`truncateSession`, idempotent + self-correcting) so Cmd-Up/Down no longer recalls rewound-away prompts. `at0097` updated to the single-step flow; both app-tests + `prompt-history-store` unit tests green.

> **Status (2026-05-31).** Step 7b.3 is **complete**: protocol plumbing, the `code-session-store` anchor + L26-safe local truncation, the turn-source projection, and the `RewindSheet` (picker + confirm, lazy diff-stat, idle gating, empty-state gating, fork-by-default). Pure-logic/unit coverage complete (25 reducer + 10 projection + slash-command/gate tests; full tugdeck suite green) **and both real-app app-tests pass** (`at0097`/`at0098`, deterministic via `driveDevSession`). Notes: (1) code-restore's real file revert is verified at the tugcode layer (test-37/39), not re-driven through the store-only app-test harness; (2) the L26 pin uses selection-survival (not raw DOM-node identity) because `TugListView` windows/reuses cells — node identity is a virtualizer property, selection-survival is the true no-remount proof; (3) post-rewind scroll follows `followBottom` to the retained tip (policy, not L26).

---

#### Step 8: `/resume` — focused sessions overlay {#step-8}

**Depends on:** #step-1c

**Commit:** `feat(dev-card): /resume sessions overlay, cancel keeps current session`

**References:** [D05] sheet-not-shared, [D15] overlays, [D23] local slash-command dispatch, [L26] stable mount identity

> **`/resume` ≠ `/rewind`.** Genuinely different operations, **no** shared component: `/resume` picks among **distinct prior sessions** (rebind this card to another conversation); `/rewind` ([#step-7]) picks among **turns within the current session**. Both, after [#step-7a], are **focused overlays via `useTugSheet`/`cardPickerSheet`** — the same mechanism `/model`, effort, and permissions already use (`dev-card.tsx:2513`).

> **Re-scoped (2026-05-30, post-code-review).** The earlier "reuse the existing chooser as-is" was wrong against the code. The session list is one section of **`DevProjectPicker`** — a **full-card, unbound-state** UI (project-path entry + recents + sessions), rendered as the *entire* card when no session is bound (`dev-card.tsx:547`, its own `dev-card-picker-backdrop`). It is **not** an overlay and **not** session-only, so it can't be dropped over a live transcript by "re-wiring cancel." `/resume` over a live session needs a **focused sessions overlay**: the existing `SessionResumeCell` renderer + sessions data source, presented through `cardPickerSheet` — reusing the *cells and data*, not the full-card chooser. The cancel-rewiring is a sub-point, not the headline.

**Artifacts:**
- New: a focused sessions-overlay sheet (`cardPickerSheet.showSheet`, card-scoped overlay per [D15]) rendering `TugListView` over the **existing** sessions data source with the **existing** `SessionResumeCell` renderer — **reuse a module-constant `cellRenderers`** (as the fresh-card picker does) so rows stay [L26]-stable; do **not** inline renderer lambdas.
- Modified: register `/resume` in the [#step-1c] registry; `RUN_SLASH_COMMAND` opens the sessions overlay.
- Reuse: the cold-boot / empty-card `DevProjectPicker` is unchanged (it keeps its full-card project+sessions flow for the unbound state).

**Tasks:**
- [x] `/resume` handler opens the focused sessions overlay via `cardPickerSheet` (`resume-sheet.tsx` — `useResumeSheet`); sessions-only, no project-path/recents chrome. Reads the bound project from `cardSessionBindingStore` and lists its sessions via the EXISTING `useDevSessionsDataSource` + module-constant `SESSIONS_CELL_RENDERERS` ([L26]); registered in the [#step-1c] registry + wired through `RUN_SLASH_COMMAND`.
- [x] Selecting a session rebinds the card and resumes it — pick-to-resume through the SAME path the full picker's Open uses: `fireRestore(cardId, sessionId, projectDir, connection)` for a resume row, `sendSpawnSession(…, "new")` for "New session" (live rows are inert). The wire send is deferred past the sheet exit animation so the binding flip doesn't unmount the sheet mid-exit (mirrors `DevProjectPicker`).
- [x] ESC / backdrop / Cancel dismisses and leaves the **live session intact** (card not closed, transcript survives); the cold-boot / empty-card `DevProjectPicker` is untouched.

**Tests:**
- [x] Real-app (`at0099-resume-command`): a live bound session (a turn driven via `driveDevSession`) → `/resume` via the real submit path opens the overlay with the **sessions list but no recents/path chrome** → Cancel dismisses and the **card stays bound with its transcript intact**. *(The pick→rebind spawn/resume round-trip goes through the shared `fireRestore`/`sendSpawnSession` path — a supervisor concern out of the store-only app-test harness's reach; the wiring is type-checked + the path is the same one the full picker exercises.)*

**Checkpoint:**
- [x] `just app-test resume-command` → PASS (`at0099-resume-command.test.ts`).

---

#### Step 9: `/permissions` picker + rules editor sheet {#step-9}

> **✅ ALREADY DONE (folded into [#step-1.6]).** This step conflated the permission **mode** (default/acceptEdits/plan/auto — shipped in [#step-1] as the Z4B chip + `Shift+Tab`) with the tool-permission **rules** editor (`/permissions`). Both shipped: the rules editor is `permission-rules-editor.tsx` (`at0090`–`at0094`). No separate work — kept as a pointer.

---

#### Step 10: `/diff` sheet via dedicated `git_diff_request` command {#step-10}

**Depends on:** #step-1c, #step-6

**References:** [D15] overlays, [D21] diff dedicated command, (#slash-cmd-inventory), `TugAccordion`, [cross-pane-modality-investigations](cross-pane-modality-investigations.md) (the sheet is pane-modal)

Split into **[#step-10a] sourcing** (tugcast `git_diff_request`/`git_diff_response`, proven by a round-trip before any UI exists) and **[#step-10b] the accordion sheet** (dev-card UI on top of the proven feed). The split de-risks the data path: 10.B builds nothing until 10.A demonstrates tugcast returns the right diff for the right project dir.

**Project dir, not "session-independent" (resolved 2026-05-31).** The diff is computed in the **session's project dir** — the same dir the Z4B GIT-status chip reflects. tugcast already keys git by exactly that: `WorkspaceRegistry` is per-`project_dir`, and each `WorkspaceEntry` runs `GitFeed::new(project_dir, …)` (`feeds/workspace_registry.rs`). tugcast is the right home not because the diff is independent of the *session* (it isn't — it's tied to the session's project) but because it's independent of the claude *process*: a diff is a filesystem fact, so `/diff` works whether claude is busy, idle, or dead, and burns no turn. tugcode runs no raw git (its `/rewind` delegates to claude's SDK `rewind_files` verb; claude exposes no diff verb), so tugcast — which already shells `git` against the project dir — is where this belongs. The request carries `root` (the project dir from session metadata) and the handler resolves the `WorkspaceEntry`, mirroring the `FILETREE_QUERY` `root`-routing adapter in `main.rs`.

**UI shape — accordion, not master/detail.** Claude Code's `/diff` is a terminal-pager affordance: a flat file list you arrow through, Enter to open one file full-screen, Esc to back out (see the two reference captures). That two-step navigation is a TUI compromise, not a model to copy. The Tug-native presentation is a single overlay sheet whose body is a **`TugAccordion type="multiple"`** with one item per changed file:

- **Header summary** at the top of the sheet body — the base ref and totals, mirroring Claude Code's framing: *"Uncommitted changes (`git diff HEAD`)"* and *"N files changed +X −Y"*.
- **One `TugAccordionItem` per file.** The trigger (collapsed header) shows the **file path** and that file's **line-count delta** (`+10 −2`); the collapsible body renders that file's hunks. All files can be open at once (`type="multiple"`), so there is no select-then-view round trip.
- **Empty state:** clean tree → "No uncommitted changes."

**Reuse existing infrastructure — do not rebuild the diff renderer.** `tugdeck/src/lib/diff/` already provides `parse-unified-diff`, `DiffData`, `countDiffStats`, and the `DiffBlock` body-kind component that renders unified-diff text into styled hunks (inline / side-by-side). Each accordion body hosts a `DiffBlock` fed `{ source: "unified", text, filePath }`; the accordion trigger owns file identity + stats, so `DiffBlock` runs with its own header suppressed. On the tugcast side, `feeds/git.rs` already shells `git` async against a `repo_dir` — the new handler follows that pattern.

**Response shape (`git_diff_response`).** A summary (`base: "HEAD"`, `file_count`, `total_added`, `total_removed`) plus `files: GitDiffFile[]`, where each file carries `{ path, old_path?, status (added|modified|deleted|renamed), added, removed, unified }` — the per-file unified-diff text, so the accordion can render `+N −M` in the collapsed trigger without the client parsing first, and lazily render hunks via `DiffBlock` on expand.

##### Step 10.A: `git_diff_request` / `git_diff_response` — tugcast sourcing + round-trip {#step-10a}

**Depends on:** (none — pure tugcast)

**Commit:** `feat(tugcast): git_diff_request command sources project-dir diff`

**Artifacts:**
- New: tugcast `git_diff_request` / `git_diff_response` control commands + handler (reusing the `git.rs` async-`git` pattern, resolving the `WorkspaceEntry` by `root`)
- Modified: tugcast control-protocol types to add the new request/response shapes
- Modified: `main.rs` request routing — a `git_diff_request` adapter mirroring the `FILETREE_QUERY` `root`-resolution (fall back to bootstrap)

**Tasks:**
- [x] Add the `git_diff_request` / `git_diff_response` shapes to the protocol. Implemented as dedicated feed IDs — `GIT_DIFF_QUERY` (0x22, request, carries `root` + `requestId`) and `GIT_DIFF` (0x21, single-shot response) — mirroring `FILETREE`/`FILETREE_QUERY`. Wire types `GitDiffSnapshot` / `GitDiffFile` / `GitDiffFileStatus` in `tugcast-core/types.rs` (echo `request_id` + `workspace_key`).
- [x] Implement the handler — `feeds/git.rs::build_git_diff_snapshot` runs `git diff HEAD -M` in the resolved `project_dir`, `parse_git_diff` splits on `diff --git` boundaries, reads git's declared status markers, counts the rendered `+`/`-` lines (header totals == body), and carries each file's unified chunk verbatim. Zero new deps — consistent with the workspace's git-CLI convention (decision logged below).
- [x] Wire the request frame routing in `main.rs` (a `root`-resolution adapter via the new `WorkspaceRegistry::resolve_diff_target`, falling back to bootstrap); per-request task, single-shot `GIT_DIFF` broadcast correlated by `request_id` + `workspace_key`.

**Addendum — gate the GIT-status poll on `.git` presence (2026-05-31).** Surfaced while reviewing 10.A: `GitFeed` polled `git status` every 2s unconditionally, so a non-git project dir (e.g. `/tmp/scratch`) forked a `git` that failed exit-128 *and* logged a warning every cycle, forever. Added `is_within_git_worktree` — a subprocess-free ancestor walk for a `.git` entry — gating the poll so a non-repo dir costs only a few `stat`s per cycle, and the feed **self-activates** on a later tick once a `.git` appears (a `git init` after the card is live). Tests: predicate (non-repo / repo-root / subdir-of-repo) + a feed test that emits nothing until `git init`, then activates. `feeds/git.rs`.

**Decision — zero-dep `git` CLI, single pass (resolved 2026-05-31).** There is no `git diff --json`; the unified diff is text. Git's `--numstat`/`--name-status` porcelain cover only *metadata* (and can disagree with the rendered hunks). A Rust git lib (`git2`/`gix`) is a heavy native/large dep used nowhere else in the workspace and still makes us re-serialize unified text. The in-workspace `tugdiff-wasm` parses a *single* file's hunks (client-side) — wrong layer/workspace. So: one `git diff HEAD`, segment + read git's own markers + count the text we render. Fully covers rename/binary; one subprocess; header == body guaranteed.

**Tests:**
- [x] Rust unit: `parse_git_diff` against fixtures for modified / added / deleted / pure-rename / rename-with-edits / binary / multi-file-order / empty (`feeds/git.rs`).
- [x] Rust integration: `build_git_diff_snapshot` against a real temp repo covering all four statuses + clean-tree-empty; `resolve_diff_target` matches a registered `root` and falls back to bootstrap on unknown/absent (`feeds/workspace_registry.rs`).

**Checkpoint (the round-trip proof):**
- [x] `cd tugrust && cargo nextest run -p tugcast` — 753 pass, 0 fail.
- [x] Live round-trip: `tests/git_diff_roundtrip.rs` spawns a real tugcast subprocess on a deliberately dirtied repo, fires a `GIT_DIFF_QUERY` over the WebSocket, and asserts the `GIT_DIFF` response carries the right files/stats/statuses for that project dir — through the full frame → router → registry → `git diff` → broadcast path, before any sheet exists. Both round-trip tests pass.

##### Step 10.B: `/diff` accordion sheet — dev-card UI {#step-10b}

**Depends on:** #step-10a, #step-1c, #step-6

**Commit:** `feat(dev-card): /diff accordion sheet over git_diff_request`

**Artifacts:**
- New: `tugdeck/src/components/tugways/cards/diff-sheet.tsx` (+ `.css`) — overlay sheet per [D15], `TugAccordion`-bodied
- New: `tugdeck/src/lib/git-diff-store.ts` — `GitDiffStore` (single-shot request/response over the GIT_DIFF feeds) + pure presentation helpers
- Modified: `protocol.ts` (`GIT_DIFF` 0x21, `GIT_DIFF_QUERY` 0x22), `card-services-store.ts` (per-card `gitDiffStore` + workspace-filtered feed), `diff-block.tsx` (`suppressHeader` prop), `lib/slash-commands.ts` (register `/diff`), `dev-card.tsx` (wire `useDiffSheet` + `diff:` surface), `test-surface.ts` (`ingestGitDiff`, v1.10.0)

**Tasks:**
- [x] Client transport: `GitDiffStore` sends `GIT_DIFF_QUERY` carrying the card's project dir (same source as the Z4B chip) as `root` + a per-store `requestId`, and resolves the matching single-shot `GIT_DIFF` response (workspace-key-filtered feed + request_id gate ignore stale/replayed frames).
- [x] Implement `DiffSheet` — header summary ("Uncommitted changes (git diff HEAD)" + "N files changed +X −Y") + `TugAccordion type="multiple"`, one item per file (trigger = status letter + path + `+N −M`; body = `DiffBlock suppressHeader` over the file's unified text, or a note for binary). Empty-tree state.
- [x] Sheet fires `git_diff_request` on open; renders via `tugdeck/src/lib/diff/` (`DiffBlock`).
- [x] Mount as overlay per [D15] — via the card's shared `cardPickerSheet.showSheet`, pane-modal (the same host the hardened cross-pane modality protects).
- [x] Refresh control (`diff-refresh`) re-fires the request; single-shot, no continuous feed subscription.

**Tests:**
- [x] Pure-logic (`git-diff-store.test.ts`, 12 cases): `+N −M` formatting, status label/letter, summary-line pluralization + empty, `fileStatLabel` binary, payload parse + order + defaults + malformed-reject.
- [x] Real-app (`at0104-diff-sheet.test.ts`): `/diff` opens the sheet; the accordion lists both files; header summarizes ("2 files changed +2 −0"); the trigger shows the path; multi-file opens collapsed; expanding a file renders its hunks; refresh → empty payload → empty state.

**Checkpoint:**
- [x] `just app-test diff-sheet` — VERDICT: PASS (1/1). Plus tsc clean and 3213 tugdeck unit tests green (slash-command registry expectations updated for `/diff`).

**Polish (2026-05-31, post-review):**
- [x] **Non-git dir is flagged, not faked.** tugcast `build_git_diff_snapshot` sets `no_repo: true` (via `is_within_git_worktree`) instead of returning a false "clean tree"; wire type + client carry it; the sheet says "Not a git repository." (Rust + TS tests).
- [x] **Empty / no-repo states show a single centered `proposal` TugLabel** — no more triple "no changes"; the "Uncommitted changes (git diff HEAD)" header context shows only when there are files.
- [x] **Header `+X −Y` uses the green/red tone colors** (matching the per-file stats).
- [x] **New `TugSheet` `displayWidth: "document"` (fixed 800px)**; `/diff` uses it for real diff-reading room.
- [x] **Diff scrolls**: the file list is a bounded scroll region (`.diff-sheet-body`, header + Done pinned); long code lines scroll horizontally within their hunk (sheet-scoped).
- [x] **DiffBlock hunk header readable**: `@@ … @@` text sized to the diff body and a larger chevron (override the cue's `--tugx-cue-*` slots, [L17]).

**Polish round 2 (2026-05-31):**
- [x] **Non-git dir wording** — the `no_repo` flag now renders "Not a git repository" (was already wired; needs a relaunch with the rebuilt tugcast to show live, since tugcast is a compiled binary).
- [x] **Empty / no-repo notice**: no trailing period, larger `proposal` TugLabel (`size="lg"`).
- [x] **Header controls are ghost** (matching block-renderer affordances) and gained **Expand All / Collapse All** — the accordion is now controlled (`value` + `toggleSectionMulti` capture, [L11]).
- [x] **TugSheet width scale → `sm`/`md`/`lg`/`xl`** (mirroring TugPushButton/TugBadge): mapped `standard→sm` (460), `wide→md` (640), `document→lg` (800), added `xl` (950). Migrated all callers; `/diff` uses `xl`.
- [x] **TugSheet `resizable` prop** (default false) — native CSS `resize: both` drag-resize ([L06], browser-owned geometry, no React state); `/diff` opts in.

**Polish round 3 (2026-05-31) — pane-modal alert:**
- [x] **New `TugAlertSheet`** (`tug-alert-sheet.tsx`) — a pane-modal alert that composes `TugSheet`'s proven modal substrate (pane-frame portal + pane scrim + `inert`, no global focus trap [D15]) with `TugAlert`'s exact look (the global `.tug-alert-*` layout classes). Avoids retrofitting Radix `AlertDialog`'s document-global focus trap into a pane (the cross-pane leak hazard). `presentAlertSheet(showSheet, opts)` rides any card's `showSheet` host; resolves `true`/`false`.
- [x] **New `TugSheet hideHeader` prop** — suppresses the title bar so `TugAlertSheet` owns the panel; `title` still labels the dialog via `aria-label`.
- [x] **`/diff` branches on first response**: a clean tree / non-git dir / error opens a lightweight `TugAlertSheet` ("No uncommitted changes" / "Not a git repository") instead of an empty diff sheet; the full sheet opens only when there are changes. (`at0104` covers the alert path → OK dismiss → then the diff path.)

**Polish round 4 (2026-05-31) — sheet drag-resize via edge handles:**
- [x] Replaced the native CSS `resize` corner (invisible nub, scrolled the whole sheet) with **pane-style edge/corner drag handles** (`e`/`w`/`s`/`se`/`sw`; no north handle — the sheet is top-anchored). Cursor affordance on every edge + a visible SE grip; geometry written to inline `width`/`height` ([L06], no React state); horizontal edges grow the centered width symmetrically (2×dx tracks the cursor), south grows downward.
- [x] **Min size** = `sm` width (460) / 250px height (clamped in the drag handlers); `max-width`/`max-height` still cap the upper bound.
- [x] **Done stays pinned while resizing**: the resizable `.tug-sheet-content` is a flex column that clips (`overflow: hidden`), with `.tug-sheet-body` → `.diff-sheet` → `.diff-sheet-body` as the only scroll region, so the footer never scrolls off as the sheet shrinks.

**Polish round 5 (2026-05-31):**
- [x] **Sheets never run off the bottom — JS canvas clamp (the rectangle-math panes use).** CSS can't see where the host pane sits relative to the canvas, so a tall `/diff` ran off-screen. `TugSheetContent` measures the bottom limit (`min(canvas-rect bottom, window.innerHeight)` — the canvas element can be taller than the viewport) and the panel's top in a `useLayoutEffect`, and sets an inline `max-height` so the panel bottom lands 16px above it — re-measured via rAF (settle) + canvas/pane `ResizeObserver` + window resize ([L06], DOM write only). The clip stays tall (it must not bound the panel); CSS `max-height` is just a no-pane fallback.
- [x] **Footer pinned + body scrolls** — the diff sheet's flex chain is all-flex (`.tug-sheet-content` flex column / clips → `.tug-sheet-body` flex:1 → scaffold flex:1 → scaffold body flex:1 `overflow-y:auto`; no fragile `height:100%`), so under the clamp the file list scrolls and Done stays at the canvas bottom.

**Audit + reusability pass (2026-05-31).** Extracted the bespoke `.tug-sheet-content:has(.diff-sheet)` footer-scroll layout into a reusable **`TugSheetScaffold`** (`header` / scrolling body / `footer`), keyed on `:has(.tug-sheet-scaffold)` so *any* sheet gets fixed-header / scrolling-body / pinned-footer for free. `/diff` now composes it. The canvas clamp, `resizable`, `hideHeader`, and `sm/md/lg/xl` are all generic `TugSheet` capabilities; `presentAlertSheet(showSheet, opts)` is the one-call pane-modal alert. Dropped the redundant rAF re-measure ([L05]). The reusable recipe: `showSheet({ displayWidth: "xl", resizable?, content: () => <TugSheetScaffold header footer>…</TugSheetScaffold> })`.
- [x] **`/diff` is no longer `resizable`** (the `TugSheet` `resizable` capability stays for other consumers). The pinned-footer / scrolling-body layout is decoupled from `resizable` via `.tug-sheet-content:has(.diff-sheet)`, so Done stays pinned and only the file list scrolls regardless.

---

#### Step 11: `/context` → status-bar CONTEXT popover {#step-11}

**Depends on:** #step-5

**Commit:** `feat(dev-card): /context opens status-bar CONTEXT popover`

**References:** [D22] context arc gauge, (#z4b-chrome-layout)

**Simplification (as built):** There is no persistent HUD and no new gauge.
The Z2 status row's **CONTEXT** cell already shows the running `used / max`
figure and, on click, the full `/context`-style breakdown (segmented arc +
per-category legend) via `ContextPopoverContent`. So `/context` simply pops
that existing popover — the same surface a click on the cell opens. No
`context-hud.tsx`, no Z4 footer slot, no extra arc-gauge instance.

**Artifacts (as built):**
- Modified: `slash-commands.ts` — register the local `/context` command.
- Modified: `dev-card-telemetry-renderers.tsx` — `DevTelemetryStatusRow`
  becomes a `forwardRef` exposing `DevTelemetryStatusRowHandle`
  (`openContextPopover()`), backed by a `TugPopoverHandle` ref on the CONTEXT
  `TugPopover` (the established `TugConfirmPopover` imperative-open pattern).
- Modified: `dev-card-placement-experiment.tsx` — `useDevPlacementSlots`
  threads a `statusRowRef` to the Z2 `DevTelemetryStatusRow` instance.
- Modified: `dev-card.tsx` — `slashCommandSurfaces.context` calls
  `statusRowRef.current?.openContextPopover()` (no-op when the row isn't the
  current Z2 datum).

**Tasks:**
- [x] Register `/context` in the local slash-command registry.
- [x] Typed `/context` opens the status-bar CONTEXT popover (the full
  token-category breakdown), via the row's imperative handle.

**Tests:**
- [x] Pure-logic: registry + completion-provider include `context`
  (`slash-commands.test.ts`).

**Checkpoint:**
- [x] `bunx tsc --noEmit` + `bun test slash-commands` green.

---

#### Step 12: Listing sheets — `/memory`, `/agents`, `/hooks`, `/skills` {#step-12}

**Depends on:** #step-1c, #step-6

Four read-only listing surfaces, each modeled on what Claude Code's terminal
actually shows for that command and each its own card-scoped overlay sheet
([D15]). Split into **12.A–12.D**, one per command. Common shape: overlays
dismiss on ESC / click-outside, focus restores to the prompt entry, each
composes `TugSheetScaffold`, and the three list surfaces reuse one
`TugListView` cell shape.

**Data reality (drives the sub-steps):** `system_metadata` carries
`slash_commands` / `skills` / `agents` as essentially **name** arrays today; it
does **not** carry memory paths, hooks, agent models, or per-skill metadata.
tugcode is the layer that reads `~/.claude` + the project plugin dir (it already
tokenizes agent `.md` / `SKILL.md` frontmatter and reads `settings.json` for the
context breakdown), so the **richer per-entry data is sourced by tugcode** and
flows to the client (enrich the existing `system_metadata` / capability arrays
from name-strings into objects — the `parseEntry` shape already accepts
`{name, description, …}`). The **rich columns are in scope**, not deferred.

**Order:** 12.D → 12.B → 12.A → 12.C.

> Note: `/mcp` was previously in this step but is now out of scope per [D14] /
> [Q06]. Hidden from slash popup.

---

##### Step 12.D: `/skills` — read-only list {#step-12d}

**Commit:** `feat(dev-card): /skills read-only listing sheet`

**References:** [D04] SessionMetadataStore hub, [D15] overlays, [#l02-slash-cmd-audit]

**Analog:** CC's `/skills` is a flat list, one row per skill. We mirror it as a
`TugListView` sheet — each row shows **name, source (`Plugin <name>` / `User`),
token estimate (`~N tok`), and a lock glyph** ("locked by author" for
plugin-managed skills), plus the description.

**Set (as built):** the **plugin + user** skills only — the on-disk,
user-manageable set, matching CC's own `/skills`. Built-in skills (claude-api,
loop, simplify…) live inside the claude package, are not on disk where tugcode
can read them, and CC excludes them from `/skills` too (they surface in
`/context`). So there is no data gap and no guessing — every column is sourced
by tugcode from each skill's `SKILL.md`.

**Transport (as built):** a single-shot **request/response through tugcode**,
mirroring `/diff`'s `GitDiffStore` and matching `/context`'s precedent of
talking to the layer that owns the data. The sheet sends a
`skills_inventory_query` CODE_INPUT; tugcode reads `<plugin>/skills/*` +
`~/.claude/skills/*` and answers with a single `skills_inventory` frame
correlated by `request_id`. tugcast relays both verbatim (CODE_INPUT → stdin,
stdout → CODE_OUTPUT) — **zero Rust changes, no ledger persistence**, and
always fresh across a card rebind / HMR reload.

**Artifacts (as built):**
- New (tugcode): `skills-inventory.ts` (builder + frontmatter field parser);
  `SkillInventoryEntry` / `SkillsInventory` / `SkillsInventoryQuery` wire types
  in `types.ts`; `skills_inventory_query` dispatch branch in `main.ts`.
- New (tugdeck): `skills-inventory-store.ts` (standalone request/response store,
  mirroring `GitDiffStore`; CODE_OUTPUT feed filtered to `type ===
  "skills_inventory"` for the session); `skills-sheet.tsx` + `.css`.
- Modified: `card-services-store.ts` (per-card `skillsInventoryStore` +
  filtered feed); register `/skills` in `slash-commands.ts`; dev-card
  `RUN_SLASH_COMMAND` surface opens the sheet.

**Tasks:**
- [x] tugcode emits per-skill metadata (name, description, source, token estimate, locked) on request.
- [x] `SkillsSheet`: read-only `TugListView` of skill rows (name · source · `~N tok` · lock), composing `TugSheetScaffold`; refresh + Done.

**Tests:**
- [x] Pure-logic: tugcode `buildSkillsInventory` + `readFrontmatterField` (9 tests); tugdeck store helpers + `parseSkillsInventoryPayload` + `_ingestForTest` (9 tests).
- [ ] Real-app: folded into the grouped `just app-test listing-sheets` checkpoint (needs a tugcode rebuild — `just app-debug` — to exercise the live round-trip).

---

##### Step 12.B: `/agents` — read-only Running + Library {#step-12b}

**Commit:** `feat(dev-card): /agents read-only Running + Library sheet`

**References:** [D04] SessionMetadataStore hub, [D15] overlays

**Scope decision:** read-only listing only — no "Create new agent", no editor
(nobody uses `/agents` to create agents; you ask Claude to write the file).
Mirrors CC's two surfaces, but as **two sections in one `TugListView`** (its
section-header role) rather than a tab control — both lists visible at once,
and neither existing tab primitive fit (TugTabBar is card-specialized;
TugRadioGroup renders radio circles). No tugcode round-trip.

**Data sources (both pure, [L02]):**
- **Running** — pending `Task` tool calls in the live transcript
  (`selectRunningAgents` over the card's `CodeSessionStore`); empty state
  otherwise. Honest live data — populates whenever a subagent is executing.
- **Library** — `BUILTIN_AGENTS` (the fixed always-available roster Claude
  ships, with its known model defaults — the same list CC's Library shows;
  nothing to introspect) merged with any plugin/user agents the wire reports
  in `slashCommands` (category `"agent"`). Built-in rows show their model
  (`claude · inherit`); plugin/user rows show their source. If CC changes its
  built-in roster, `BUILTIN_AGENTS` is the one place to update.

**Artifacts (as built):**
- New: `agents-list.ts` (`BUILTIN_AGENTS`, `selectLibraryAgents`,
  `selectRunningAgents`, `agentTrailingLabel`), `agents-sheet.tsx` + `.css`
- Modified: register `/agents` in `slash-commands.ts`; dev-card
  `RUN_SLASH_COMMAND` surface opens the sheet (wired to both
  `sessionMetadataStore` + `codeSessionStore`)
- **No tugcode / wire changes.**

**Tasks:**
- [x] `AgentsSheet`: sectioned read-only `TugListView` (Running rows / empty
  state, then Library rows: name + model/source), composing `TugSheetScaffold`; Done.

**Tests:**
- [x] Pure-logic: `selectLibraryAgents` (built-in roster + plugin/user merge +
  dedup), `agentTrailingLabel`, `selectRunningAgents` (pending-Task filter) (6 tests).
- [ ] Real-app: folded into the grouped `just app-test listing-sheets` checkpoint.

---

##### Step 12.A: `/memory` — list → open in the OS editor {#step-12a}

**Commit:** `feat(dev-card): /memory listing sheet opens files in the OS editor`

**References:** [D04], [D15]; existing `AppDelegate` `NSWorkspace.shared.open` precedent (`openProjectHome` / `openGitHub`); the `webkit.messageHandlers` bridge (`frontendReady` / `setDevMode`)

**Analog:** CC's `/memory` shows "Auto-memory: on" then a short list — `Project
memory → ./CLAUDE.md`, `User memory → ~/.claude/CLAUDE.md`, `Open auto-memory
folder` — and selecting a row opens an editor. We mirror it as a `TugListView`
sheet whose row-click **hands the path to the OS** (file → default editor;
folder → Finder).

**Decision (this step):** OS-open only — **no embedded editor, no read/write
IPC.** An in-app memory editor is a future project, explicitly out of scope here.
The "Auto-memory: on/off" status line is dropped — that flag isn't on the wire
(tugcode's settings reader only carries `autoCompactEnabled`), so showing it
would be a guess.

**Resolved-cwd architecture (general, not a `/memory` one-off):** the
auto-memory folder is named after **claude's resolved cwd** (`/Users/…`), not
the path the user picked (which may be a symlink like `/u/src/tugtool`).
Resolving that needs the filesystem, which the web layer doesn't have — and the
form must match claude exactly (Bun's `realpathSync` does; Rust's
`fs::canonicalize` gives the wrong `/System/Volumes/Data/…` firmlink form). So
tugcode now **canonicalizes its project dir once at startup** (`main.ts`
`realpathSync`) and that single value feeds the context-breakdown emitter, the
JSONL replay path, claude's spawn cwd, AND a minimal **`system_metadata` frame
emitted at spawn** carrying just `cwd`. tugcast's field-aware merge + on-subscribe
replay deliver it to `SessionMetadataStore.cwd` **from the drop** (before any
turn, race-free). Every cwd-derived feature reads that one `meta.cwd` — `/memory`
here, and the context breakdown's `memory_files` tokenization is fixed as a
freebie (it was mis-encoding the auto-memory dir from the alias).

**Artifacts (as built):**
- tugcode: `main.ts` canonicalizes `projectDir`; `session.ts`
  `emitInitialSessionCwd()` emits the spawn-time `cwd` frame; `SystemMetadata`
  content fields made optional (a frame carries only what its emitter knows).
- New (host): an `openPath` `WKScriptMessageHandler` case in
  `tugapp/Sources/MainWindow.swift` — expands a leading `~` (the web layer has
  no home dir) and routes via `NSWorkspace` by `kind`: a **file** opens in the
  default editor, **creating it (+ parent dirs) if absent** (matching CC's
  "open memory" — a not-yet-written CLAUDE.md still opens to edit); a **folder**
  opens in Finder (walking up to the nearest existing ancestor as a safety net,
  now rarely needed since `cwd` is correct from the drop).
- New (tugdeck): `os-open.ts` (`openPathInOS` — posts to the host handler,
  no-ops off-host), `memory-destinations.ts` (pure `encodeProjectDir` +
  `memoryDestinations(cwd)`), `memory-sheet.tsx` + `.css`.
- Modified: register `/memory` in `slash-commands.ts`; dev-card
  `RUN_SLASH_COMMAND` surface opens the sheet.

**Tasks:**
- [x] Host `openPath` handler (open file in default editor / folder in Finder /
  reveal parent when missing) + the `openPathInOS` JS bridge helper.
- [x] `MemorySheet`: lists project `CLAUDE.md`, user `~/.claude/CLAUDE.md`, and
  the auto-memory folder, all derived from `meta.cwd` (populated from the drop
  via the spawn-time frame); **interactive** rows (`delegate.onSelect` →
  `openPathInOS(path, kind)`); `displayWidth: "md"`; composing `TugSheetScaffold`; Done.

**Tests:**
- [x] Pure-logic: `encodeProjectDir` + `memoryDestinations` (paths / kinds /
  cwd-unknown fallback) (4 tests).
- [ ] Real-app: folded into the grouped `just app-test listing-sheets`
  checkpoint (the `openPath` bridge needs the rebuilt host — `just app-debug`).

---

##### Step 12.C: `/hooks` — read-only accordion {#step-12c}

**Commit:** `feat(dev-card): /hooks read-only accordion sheet`

**References:** [D04], [D15]; `tugcode/src/claude-code-settings.ts` (settings reader); `TugAccordion` (the `/diff` precedent)

**Analog:** CC's `/hooks` shows "N hooks configured", a read-only notice, and a
list of hook events (PreToolUse (2), PostToolUse, PostToolUseFailure,
PostToolBatch, PermissionDenied, …); drilling into one shows its matchers +
the input-contract explanation. We mirror it as a **`TugAccordion`** sheet —
one item per hook event (trigger = `EventName (N)` + one-line description),
body = configured matchers/commands or "No hooks configured for this event,"
under a top read-only notice banner.

**Transport (as built):** request/response through tugcode, same shape as
`/skills` — the sheet sends a `hooks_query`; tugcode reads the `hooks` block of
the user / project / local `settings.json` files and answers with a single
`hooks_inventory` frame (each event's matcher groups concatenated across scopes,
CC's all-scopes-fire semantics). Kept out of `claude-code-settings.ts` (which is
about `autoCompactEnabled`) — hooks live in their own `hooks-inventory.ts`
builder, mirroring `skills-inventory.ts`.

**Artifacts (as built):**
- New (tugcode): `hooks-inventory.ts` (reads + merges the settings `hooks`
  blocks); `HooksQuery` / `HookCommand` / `HookMatcherGroup` / `HooksInventory`
  wire types in `types.ts` (+ the `isInboundMessage` allowlist entry);
  `hooks_query` dispatch in `main.ts`.
- New (tugdeck): `hooks-inventory-store.ts` (request/response store + the static
  `HOOK_EVENT_CATALOG` + the `selectHookEventRows` / `countHooks` projection);
  `hooks-sheet.tsx` + `.css`.
- Modified: `card-services-store.ts` (per-card `hooksInventoryStore` + filtered
  feed); register `/hooks`; dev-card surface.

**Tasks:**
- [x] tugcode parses + emits the merged hooks config (event → matcher groups).
- [x] `HooksSheet`: read-only `TugAccordion` over the catalog joined with the
  configured hooks; per-event count in the trigger; read-only notice banner;
  composing `TugSheetScaffold`; refresh + Done.

**Tests:**
- [x] Pure-logic: tugcode `buildHooksInventory` (parse / cross-scope merge /
  malformed-drop) (4 tests); tugdeck `selectHookEventRows` / `countHooks` /
  `parseHooksInventoryPayload` / `_ingestForTest` (10 tests).
- [ ] Real-app: folded into the grouped `just app-test listing-sheets`
  checkpoint (needs the rebuilt tugcode — `just app-debug`).

**Checkpoint (12.A–12.D):**
- [x] **Closed.** All four listing sheets verified live (`just app-debug`) and
  covered by per-layer pure-logic tests (tugcode builders + tugdeck
  store/projection/parse). The bundled `just app-test listing-sheets` was
  intentionally not authored — these are read-only projection surfaces with no
  engine/editor behavior to assert, and live verification + the pure-logic
  suites are the right-layer coverage here. Step 12 is complete.

---

#### Step 13: Slash-popup filtering + UI-affordance command mappings {#step-13}

**Depends on:** #step-1c, #step-5, #step-6

In stream-json / print mode claude has **no interactive UI**, so none of these
commands survive as pass-throughs — each is either a Tug-local reimplementation
or a cross-layer feature. [D14]'s allowlist sorts every command into three
tiers — (1) **pass-through** (`prompt`/skill commands, sent to claude verbatim);
(2) **local with a Tug surface** ([D23] registry); (3) **hidden** — and building
that filter is the spine of this step; everything else registers into it. Split
into **13.A–13.E**, grouped by where the work lives, mirroring [#step-12].

**`/bug` is hidden (tier 3).** In the terminal it files feedback to Anthropic;
over the bridge that has no meaning. It joins `/vim`, `/theme`, `/color`,
`/mcp`, `/quit`, `/login`/`/logout`, `/usage`, … in the unsupported doc — no
mapping, absent from the popup. The remaining seven map to surfaces.

**Order:** 13.A (filter spine) → 13.B (pure-client) → 13.C (host/IPC bridge) →
13.D (`/rename`) → 13.E (`/btw`). 13.A is foundational (13.B's `/help` renders
the allowlist-filtered command list); the rest are independent after it.

**References (whole step):** [D11] btw exclude flag, [D14] unsupported-list,
[D23] local slash-command dispatch, [D16] clear+help supported, [D15] overlays,
[#l02-slash-cmd-audit] (`/rename` cheap-win), (#slash-cmd-inventory)

---

##### Step 13.A: Slash-popup filtering + unsupported doc {#step-13a}

**Commit:** `feat(dev-card): slash-popup filtering + unsupported-command doc`

**References:** [D14] unsupported-list, [D23] local dispatch, [#q09-slash-popup-filter], (#slash-cmd-inventory)

This is the spine the other sub-steps plug into. The allowlist is a **three-tier
classifier** by name, not a flat list: `supported-local` (a [D23] registry command
with a Tug surface), `pass-through` (neither local nor hidden), and `hidden` (the
known-unsupported set, swallowed silently at submit).

**Catalog-aware refinement (added during implementation).** A by-name
`pass-through` is refined at submit against the command catalog claude reports
(`slash_commands ∪ skills ∪ agents`): a name claude *reports* is sent verbatim
(real turn); a name claude does *not* report — and the catalog is populated — is a
**genuine unknown** (a typo) and gets a client-side *Unknown command* alert
(`presentAlertSheet`) instead of burning a turn. (Before this, a typed `/foo`
reached claude, which wasted a turn and replied with a terminal-flavored "Did you
mean …?" that could even suggest a command we hide.) The catalog-empty case (pre
handshake) falls through to claude, so a valid command typed early is never
wrongly rejected. The by-name classifier stays catalog-free and pure; the
catalog check (`isUnknownRemoteCommand`) layers on top at the dev card.

**Artifacts (as built):**
- New: `tugdeck/src/lib/slash-supported.ts` — the tier classifier. `SUPPORTED_LOCAL` is **derived from `LOCAL_SLASH_COMMANDS`** (so a command added to the [#step-1c] registry in a later sub-step becomes `supported-local` with no second edit); `HIDDEN_SLASH_COMMANDS` is the explicit known-unsupported set; `classifySlashCommand` / `isHiddenSlashCommand` are the lookups. (No `GRAPHICAL_SUPPORTED_COMMANDS` constant — deriving the supported set from the registry is the future-proof shape.)
- New: `tuglaws/dev-card-unsupported-slash-commands.md` — discoverable list of every hidden command + why, grouped by reason; mirrors `HIDDEN_SLASH_COMMANDS`. Filed under `tuglaws/` (the sanctioned docs home per [D14]'s own pointer), indexed in `tuglaws/INDEX.md`.
- New: `filterCommandProvider` in `completion-providers/local-commands.ts` — wraps a command provider, dropping items whose name fails a predicate.
- Modified: `dev-card.tsx` composition layer wraps `getCommandCompletionProvider()` in `filterCommandProvider(…, (name) => !isHiddenSlashCommand(name))`. **Placement note:** [D14] proposed filtering *inside* the store; built at the **composition layer** instead, to keep the generic `SessionMetadataStore` free of dev-card command policy — the same reasoning that already keeps the local-command merge out of the store ([#step-1c]). Observable behavior is identical: claude's reported `hidden` commands never reach the dev-card popup.
- Modified: `slash-commands.ts` exports `slashCommandName(text)` (name-only parse). `mergeCommandProviders` sorts the deduped popup **alphabetically** (dedup precedence still local-first; display order predictable).
- Notice for a typed `/command` the card won't run: one action `SHOW_SLASH_COMMAND_NOTICE` (`action-vocabulary.ts`) carrying `reason: "unknown" | "unsupported"`. `tug-prompt-entry.tsx` `performSubmit` (after the local dispatch) classifies the name — `hidden` (→ `unsupported`, never sent to claude) or catalog-aware `isUnknownRemoteCommand` (→ `unknown`, a typo) — and dispatches the notice key-card-scoped; an unknown with no responder falls through to `send()`. `dev-card.tsx` presents a `presentAlertSheet` with reason-appropriate text (*Command not available* / *Unknown command*). `isUnknownRemoteCommand` is pure (catalog-empty → false; non-pass-through → false; else not-in-catalog); the prompt entry already received `sessionMetadataStore` — now consumed.
- **Catalog from the drop (root-cause fix):** the catalog was empty until a post-turn `system_metadata`, so unknown-detection no-op'd on the first input. Fixed in `session-metadata-store.ts`: the turn-free `initialize` handshake's `session_capabilities.commands` (available from the drop) now populates `slashCommands` (`parseCommandCatalog`), and an empty `system_metadata` replace no longer wipes a populated catalog. See memory `session-metadata-from-drop` for the general two-source principle (handshake vs post-turn) this recurs on.

**Tasks:**
- [x] Define the three-tier classifier in `slash-supported.ts` (`classifySlashCommand` / `isHiddenSlashCommand`; `SUPPORTED_LOCAL` derived from the registry, `HIDDEN_SLASH_COMMANDS` explicit).
- [x] Filter popup output — `hidden`-tier commands absent from the popup per [D14] (`filterCommandProvider` at the dev-card composition layer); `pass-through` + `supported-local` visible.
- [x] A typed `hidden` command is never sent to claude and shows a *Command not available* notice (not a silent drop); a genuine unknown shows an *Unknown command* notice; unknown `/names` with no responder still go to claude. Popup output is alphabetized.
- [x] Author `dev-card-unsupported-slash-commands.md` listing every hidden command + why (`/bug`, `/vim`, `/theme`, `/color`, `/mcp`, `/quit`, `/login`, `/logout`, `/usage`, …), filed in `tuglaws/` + indexed. **Popup "?" link not built:** the completion popup is a CodeMirror extension with no help affordance today — building one is a generic-text-editor primitive change (scope creep for 13.A). The doc is at a canonical path and `/help` (13.B) will surface it.

**Tests:**
- [x] Pure-logic: classifier returns the right tier for a sampled catalog (supported-local / pass-through / hidden); unknown `/name` defaults to pass-through *by name* (`slash-supported.test.ts`).
- [x] Pure-logic: `isUnknownRemoteCommand` — empty catalog → not unknown; pass-through name absent from a populated catalog → unknown; present → not unknown; local/hidden names → never unknown (`slash-supported.test.ts`).
- [x] Pure-logic: `filterCommandProvider` drops exactly the failing names + passes the query through; `slashCommandName` extraction (`slash-commands.test.ts`). The submit-side swallow + unknown-command alert dispatch are exercised live (real-app), not fake-DOM tested.

**Checkpoint:**
- [x] **Closed.** tsc clean; full pure-logic suite green (3257 pass). The filter is live via HMR. The bundled `just app-test slash-filtering` was **not** authored — popup filtering is a projection over a tested pure classifier + a one-line tested provider wrapper, and a real-app variant would need a live claude session reporting commands to assert popup contents; consistent with how the Step 12 listing sheets closed, the per-layer pure-logic suites are the right-layer coverage. Verifiable live: `/` popup omits `/vim`/`/bug`/…; typed `/vim` is a silent no-op; typed `/foo` (genuine unknown) raises the *Unknown command* alert instead of sending a turn.

---

##### Step 13.B: Pure-client commands — `/copy`, `/help`, `/clear` {#step-13b}

**References:** [D16] clear+help supported, [D15] overlays, [D23] local dispatch, [L23] transcript is user-visible state

These three are pure client — no host bridge, no control verb, no IPC — but each
carries its own design, so they split into **13.B.1–13.B.3**, one per command,
each committed separately. Order: 13.B.1 → 13.B.2 → 13.B.3.

---

###### Step 13.B.1: `/copy` — copy last message + pane-scoped bulletin {#step-13b1}

`/copy` copies the **last `assistant_text` accumulation** to the clipboard and,
on success, raises a **pane-scoped bulletin** reading *"Most recent message
copied"*; Cmd+Shift+C is bound to the same action.

The pane-scoped bulletin is a **new primitive**, not a one-off. `TugBulletin`
today is **deck-global** — a single Sonner `Toaster` mounted once at root — and
Sonner does real work we'd otherwise lose: correct **stacking** of overlapping
bulletins, **persist-on-interaction** (a clicked / hovered bulletin hangs around),
and **reliable dismissal**. A copy confirmation belongs to the **card** it came
from, so we need a pane-scoped equivalent that does that work properly. That's
worth its own primitive + gallery card before any feature adopts it — so 13.B.1
splits into **13.B.1.A** (the primitive) and **13.B.1.B** (the `/copy` adoption).

---

###### Step 13.B.1.A: `TugPaneBulletin` primitive + gallery card {#step-13b1a}

**Commit:** `feat(tugways): TugPaneBulletin pane-scoped bulletin + gallery card`

**References:** [L06] appearance via CSS/DOM, [L14] Sonner owns enter/exit animation, [L17] one-hop aliases, [L19] component authoring, [#feedback] use existing Tug components / gallery-first / don't reinvent

A proper pane-scoped bulletin primitive — the per-pane analog of the deck
`TugBulletin`. **Decision (course-correct):** a first attempt hand-rolled the
stack (store + per-row timers + FLIP reflow) and kept hopping / glitching on
removal — re-implementing what Sonner already does well. We **already depend on
Sonner**, and Sonner 2.x scopes by **`toasterId`** (a `<Toaster id>` shows only
toasts whose `toasterId` matches; the deck's id-less toaster shows only id-less
toasts). So the pane bulletin is a thin Sonner wrapper, exactly like the deck
one — stacking, hover-to-persist, swipe/close, and smooth enter/exit/reflow come
from Sonner, scoped per pane. No reinvention.

- **Pane-scoped:** each `TugPaneBulletinProvider` mounts a `<Toaster id={useId()}>`
  and `useTugPaneBulletin()` raises toasts addressed to that id — one card's
  bulletins never appear over another's.
- **Containment:** Sonner renders inline (no portal) and positions container-
  relative (`bottom`/`left`); the provider's root is `position: relative;
  isolation: isolate` and the CSS overrides Sonner's `position: fixed` →
  `absolute`, anchoring the stack to the pane (not the viewport).
- **Appearance via CSS only** ([L06]) on `unstyled` toasts, mirroring
  `tug-bulletin.css`; tone variants via `toast.success/.error/.warning`.

**Gallery card (gallery-first per feedback):** a `TugPaneBulletin` gallery card
(sibling of the deck-bulletin card) firing single / tone / stack-three /
long-duration bulletins so stacking, hover-persist, and dismissal are exercised
by hand. Registered in `gallery-registrations.tsx`.

**Artifacts (as built):**
- New: `tug-pane-bulletin.tsx` (+ `.css`) — `TugPaneBulletinProvider` (mounts a Sonner `<Toaster>` with a `useId()` id inside a relative+isolated root) and `useTugPaneBulletin()` (imperative `paneBulletin()` + `.success`/`.danger`/`.caution`, each routing `toast(...)` with `toasterId`). Options mirror the deck `BulletinOptions` (`description`/`duration`/`action`). CSS styles the `unstyled` toast like the deck bulletin + the `position: fixed → absolute` containment override + a contained `z-index` (root `isolation: isolate`).
- New: `gallery-pane-bulletin.tsx` + registration in `gallery-registrations.tsx`.
- (Removed the first attempt's bespoke `tug-pane-bulletin-store.ts` + FLIP — superseded by Sonner.)

**Tuglaws touched:** [L06] (CSS appearance), [L14] (Sonner owns enter/exit/reflow animation), [L17] (one-hop `--tugx-pane-bulletin-*` aliases), [L19] (component authoring + gallery card).

**Tests:**
- [x] No pure-logic test — a thin Sonner wrapper has no bespoke logic to unit-test (we don't test Sonner), exactly like the deck `TugBulletin`. Verified live via the `TugPaneBulletin` gallery card: stacking, hover-persist, ✕ dismiss, smooth removal/reflow (Sonner), pane containment.

**Checkpoint:**
- [x] Exercised live in the gallery card (`TugPaneBulletin`); tsc clean; full pure-logic suite green (3263 pass).

---

###### Step 13.B.1.B: `/copy` adoption {#step-13b1b}

**Commit:** `feat(dev-card): /copy copies last message + pane bulletin`

**References:** [D23] local dispatch, [#step-13b1a] TugPaneBulletin, [L07] read live state at event time

`/copy` copies the **last `assistant_text`** to the clipboard and raises a
`TugPaneBulletin` *"Most recent message copied"* in the dev card; Cmd+Shift+C is
bound to the same action. Depends on 13.B.1.A.

**Artifacts (as built):**
- New (pure): `lastAssistantCopyText(transcript)` in `turn-entry-markdown.ts` — walks committed turns newest-first, returns the first non-empty `turnEntryToMarkdown` (the exact text the per-row COPY produces), skipping interrupted/empty turns; `null` when nothing copyable. Operates on the committed transcript only (never a half-streamed turn).
- Wiring: the dev card wraps its **header + transcript** (not the Z2 status bar) in a `TugPaneBulletinProvider` (`.dev-card-bulletin-host`, `flex:1; overflow:hidden`), so the bulletin anchors to the bottom of the transcript region — above Z2, and with no outer scrollbar. `PaneBulletinAnchor` (the status-row handle-ref pattern) hands the bulletin API up to the `/copy` handler. `/copy` registered in the [#step-1c] registry; its handler reads the transcript live ([L07]), copies via `navigator.clipboard`, and raises a **success-tone** (green) bulletin *"Most recent message copied"* (no message → caution; clipboard failure → danger).

**Keybinding (decision):** **Cmd+Shift+C NOT bound** — it is already `SELECT_ROUTE` ("❯" chat route) in `keybinding-map.ts`, and ⌘C is already clipboard `COPY`. Clobbering a documented shortcut wasn't worth it; `/copy` is **slash-only**. Revisit if a free chord is wanted.

**Tests:**
- [x] Pure-logic: `lastAssistantCopyText` — empty → null; most-recent assistant turn; reuses `turnEntryToMarkdown`; skips a trailing interrupted turn; null when no assistant content (`turn-entry-markdown.test.ts`). Registry-list pins updated for `/copy` (`slash-commands.test.ts`).
- [x] Real-app: `/copy` copies the last assistant message and raises the green pane bulletin above Z2 (verified live).

**Checkpoint:**
- [x] tsc clean; full suite green (3268 pass); verified live (`/copy` → green "Most recent message copied" above Z2, no scrollbar). Bundled `just app-test copy-command` not authored — the selector is pure-tested and the surface is the pane bulletin (live), consistent with prior closes.

---

###### Step 13.B.2: `/help` — help sheet {#step-13b2}

**Commit:** `feat(dev-card): /help sheet`

**References:** [D16] help supported, [D15] overlays, [D23] local dispatch

✅ **DONE.** `/help` opens a **`TugSheet`** (card-scoped overlay per [D15]) with
two tabs: **General** (what Tide is + the verified keyboard shortcuts + a link to
the unsupported-commands doc) and **Commands** (the built-in command list). The
command list is projected from `SessionMetadataStore.slashCommands` through the
13.A allowlist (`projectHelpCommands` in `help-content.ts`) and narrowed to
commands the dev card has help text for — `local`-category, hidden filtered,
description-required; skills + agents are left to the slash popup and `/agents`,
and claude's description-less built-ins (`/clear`, `/init`, `/compact`, …) are not
listed blank. The terminal's third "Custom commands" tab was dropped by decision —
bundled-marketplace plugin skills aren't this project's own commands and we can't
tell them apart from the catalog names. Tabs use the `permission-rules-editor`
in-sheet `TugTabBar` idiom; the command list is a non-interactive `TugListView`.

**Artifacts:**
- ✅ New: `help-sheet.tsx` (overlay per [D15]) + `help-sheet.css`.
- ✅ New: `help-content.ts` — pure General-tab copy + `projectHelpCommands`.
- ✅ Wiring: registered `/help` in the [#step-1c] registry + its `RUN_SLASH_COMMAND` handler in `dev-card.tsx`.

**Tests:**
- ✅ Pure-logic: `slash-commands.test.ts` registry pins cover `/help`; `slash-supported.test.ts` auto-covers it as `supported-local`. (A dedicated `help-content` projection test was written then removed — it asserted nothing that could fail.)
- ⏭️ Real-app: waived per user direction — verified interactively in the running app instead.

**Checkpoint:**
- ⏭️ `just app-test help-sheet` — waived; verified live (HMR) during review.

---

###### Step 13.B.3: `/clear` — mini spike, then implement {#step-13b3}

**Commit:** `feat(dev-card): /clear fresh session + rebuild store on session change`

**References:** [D16] clear supported, [L23] transcript is user-visible state, [D23] local dispatch

✅ **DONE** (spike resolved + implemented).

**Spike findings:**
- **Semantics (user-confirmed):** `/clear` = **spawn a fresh session in this card**.
  The prior session persists on disk and is resumable via `/resume` if it had
  committed turns. [L23]-honest: we never *wipe* a transcript — we bind the card
  to a new, empty session.
- **Mechanism already exists:** the resume sheet's "New session" row already does
  `crypto.randomUUID()` + `sendSpawnSession(conn, cardId, id, projectDir, "new")`.
  `/clear` reuses it as a one-shot (no picker), dispatched via the [D23] registry
  like `/copy`.
- **The real blocker found:** `cardServicesStore._reconcile` rebuilt a card's
  `CodeSessionStore` only when a **cardId** appeared/vanished — it did **not**
  react to a `tugSessionId` *change* on an already-bound card. So a binding flip
  to a new session kept the old transcript. This same gap sat under
  `/resume`-to-a-different-session and the resume "New session" row (neither was
  tested for transcript reset on a live card — `at0099` only covers Cancel).

**Chosen approach (user-approved):**
- **Fix `_reconcile` globally** — detect a `tugSessionId` change for an existing
  card → dispose + reconstruct fresh services (which re-fires `request_replay`:
  empty for a new session, full for a resumed one). `CardServices` now carries
  its `tugSessionId` so the change is detectable. The binding store is the single
  source of truth for "which session this card shows"; this fixes `/clear`,
  `/resume`-different, and resume-"New session" in one place. The card stays bound
  throughout (old → new), so the project picker never flashes.
- **`/clear` closes the old subprocess** — spawn the new session, then
  `sendCloseSessionKeepingBinding` for the old (a `close_session` frame that does
  NOT clear the binding, since the binding flips to the new session on the spawn
  ack). The old subprocess is torn down; the session stays on disk/resumable.

**Artifacts:**
- ✅ `card-services-store.ts` — `CardServices.tugSessionId` + `_reconcile` session-change rebuild.
- ✅ `session-lifecycle.ts` — `sendCloseSessionKeepingBinding`.
- ✅ `slash-commands.ts` — registered `/clear`; `dev-card.tsx` — `RUN_SLASH_COMMAND` `clear` surface.

**Tests:**
- ✅ Pure-logic: `card-services-store-request-replay.test.ts` gains a session-flip case (same card → new `tugSessionId` rebuilds the bag: fresh store + `request_replay` for the new session). `slash-commands.test.ts` registry pins cover `/clear`; `slash-supported.test.ts` auto-covers it.
- ⏭️ Real-app: verified interactively in the running app (HMR) — `/clear` resets the transcript with no picker flash; old session resumable via `/resume`.

**Checkpoint:**
- ✅ `bunx tsc --noEmit` clean; full suite green (3269 pass).

---

##### Step 13.C: Host/IPC-bridge commands — `/export`, `/add-dir` {#step-13c}

**Commit:** `feat(dev-card): /export save dialog + /add-dir directory picker`

**References:** [D23] local dispatch, host `openPath` bridge precedent ([#step-12a])

✅ **DONE.** Both need a host/IPC affordance beyond the client — that's what
groups them.

- **`/export`** — fully implemented. The export *content* (both Markdown and
  JSON Lines renderings) is built client-side from the committed transcript
  (`transcript-export.ts`); the host owns the save panel + file write. The new
  `exportSession` host bridge (`MainWindow.swift`, sibling of `openPath`) runs an
  `NSSavePanel` with a **File Format popup** (Markdown / JSON Lines) and writes
  the selected format's content. `os-export.ts` posts both renderings + a default
  base name and resolves `saved` / `canceled` / `unavailable`; outcomes surface
  in the card's pane bulletin.
- **`/add-dir`** — the native directory picker is reused (`pickPath("directory")`
  via the existing `choosePath` host bridge); the chosen path is added through a
  new **`add_directory` CODE_INPUT verb**. (The first cut tried handing the path
  to claude's own `/add-dir` as a pass-through turn — claude rejects it headless:
  *"`/add-dir` isn't available in this environment."* So a real verb was built.)
  Mechanism mirrors `effort_change`: `code-session-store.addDirectory` →
  CODE_INPUT (tugcast relays it generically by session id — no Rust change) →
  tugcode `handleAddDirectory` appends the dir to its `additionalDirectories`
  and respawns claude with the dir in `--add-dir` (+ `--resume`), since claude
  has no live add-directory control verb. The dir survives resume / fork /
  continue (re-applied by `buildClaudeArgs` on every spawn).

**Artifacts:**
- ✅ Host: `exportSession` `NSSavePanel` case in `MainWindow.swift` (registered + cleaned up alongside `openPath`); `/add-dir` reuses the existing `choosePath` `NSOpenPanel`.
- ✅ tugdeck: `os-export.ts` (save-panel bridge) + `transcript-export.ts` (Markdown + JSONL formatter); `/add-dir` reuses `native-path-picker.ts`; `code-session-store.addDirectory` + the `add_directory` `InboundMessage`.
- ✅ tugcode: `add_directory` type + guard + `isInboundMessage` allowlist (`types.ts`); `main.ts` handler; `session.ts` `handleAddDirectory` + `additionalDirectories` field threaded through `buildClaudeArgs` (re-applied on every spawn). No tugcast/Rust change — CODE_INPUT is relayed generically.
- ✅ Wiring: registered `/export`, `/add-dir` in the registry + `RUN_SLASH_COMMAND` surfaces in `dev-card.tsx`.

**Tests:**
- ✅ Pure-logic: `transcript-export.test.ts` (JSONL one parseable object per Message in order; Markdown prompt+response under headings; empty + filename cases); `session.test.ts` gains `buildClaudeArgs` `--add-dir`-per-directory cases; `slash-commands.test.ts` pins cover `/export` + `/add-dir`.
- ⏭️ Real-app: native `NSSavePanel` / `NSOpenPanel` are OS-modal windows (not in the WebView DOM), so they can't be driven by an in-DOM app-test. Verify live after a rebuild.

**Checkpoint:**
- ✅ tugdeck + tugcode `tsc` clean; tugdeck suite 3275 pass, tugcode suite 549 pass; Swift `BUILD SUCCEEDED`; tugcode binary recompiled. Needs `just app-debug` to take effect live (Swift host bridge + bun-compiled tugcode have no HMR).

---

###### Step 13.C.1: `tugproto` shared inbound-verb contract + registry {#step-13c1}

**Commit:** `refactor: tugproto shared inbound-verb contract + tugcode verb registry`

**References:** [D23] local dispatch, the `add_directory` build ([#step-13c]) as the motivating pain, the `reference_tugcode_inbound_allowlist` footgun (a missed allowlist edit → `Invalid message type`, sheet hangs).

> **Status: ✅ DONE.** Built as planned, with two as-built refinements the
> investigation forced (below). Resolution proven on all three bundler paths;
> both suites green.
>
> **As-built deltas from the plan:**
> - **The two unions had drifted** — tugdeck's was the client *send-subset* (12
>   verbs, sender-permissive payloads), tugcode's the *receive-superset* (16,
>   incl. `protocol_init`/`request_replay`/`skills`/`hooks`), and `ContentBlock`
>   was defined in both. Resolved by authoring the **full** contract once in
>   `tugproto` with the **strict (receiver) types** for the 3 fields that diverged
>   (`mode: PermissionMode`, `answers: Record<string, string>`,
>   `updatedInput?: Record<string, unknown>`) and **tightening the tugdeck sender
>   stack to match** — `events.ts` → `code-session-store` → `use-permission-mode`
>   → `permission-mode.ts` → `permission-mode-chip`. No boundary casts: the one
>   untrusted input (the *persisted* mode string) is validated with an
>   `isPermissionMode` guard at the persistence boundary, and the chip's *display*
>   of the live mode stays a tolerant `string` (claude may report any mode). The
>   mode value space (`PermissionMode`) is now authored once in `tugproto` and
>   sourced by both tugcode's `permissions.ts` and tugdeck's `permission-mode.ts`;
>   `PERMISSION_MODE_CYCLE`/`_MENU` gained `satisfies readonly PermissionMode[]`
>   (a typo'd cycle mode is now a compile error). *(First cut used
>   sender-permissive types + boundary narrowing; tightened to strict end-to-end
>   on review — it converged cleanly across ~6 files, both suites green.)*
> - **Per-type guards kept.** A dedicated `types.test.ts` exercises them, and
>   they're harmless one-liners. The win is `isInboundMessage` **derived from
>   `INBOUND_VERBS`** (the silent-allowlist footgun is gone) + the registry
>   replacing the `if/else`. A new verb no longer *needs* a guard.
> - **`protocol_init` + `user_message` stay special-cased** in `main.ts` (the
>   handshake + the hot turn path); the registry owns the other 14 verbs.
> - **Resolution:** repo-root `tugproto/`, `@tugproto/*` tsconfig path (both
>   packages) + a Vite `resolve.alias` (tugdeck). Vite's default `fs.allow`
>   already covers a repo-root sibling via its `.git` workspace-root detection,
>   so no `server.fs` change was needed.

**Why.** Adding one CODE_INPUT verb (`add_directory`, [#step-13c]) touched ~6
sites, of which only three are real work (client send-intent, server handler,
UI affordance). The rest is boilerplate that *rots*: the wire contract is
authored **twice** (tugdeck `protocol.ts` `InboundMessage` ∪ tugcode
`types.ts` interface + union), and tugcode mirrors the union in **three more
places** — the `isInboundMessage` allowlist, a per-type `isXxx` guard, and a
hand-written `else if` branch in the 16-way `main.ts` dispatch. The allowlist
miss is a *silent* failure (documented footgun). The fix is the same shape the
codebase already uses on the UI side (`LOCAL_SLASH_COMMANDS`): author the
contract once, derive the rest from a registry.

**Grounding (investigated 2026-06-01):**
- **16 inbound verbs** today: `protocol_init`, `user_message`, `tool_approval`,
  `question_answer`, `interrupt`, `permission_mode`, `model_change`,
  `effort_change`, `add_directory`, `session_command`, `stop_task`,
  `request_replay`, `rewind_preview`, `session_rewind`, `skills_inventory_query`,
  `hooks_query`. Dispatched by an `if/else` chain (`main.ts` ~191–464).
- **No workspace.** tugdeck (vite, `@/*` → `src/*`) and tugcode (`bun build
  --compile`, no path aliases) are independent bun packages. A "shared package"
  here is a **source-only dir both bundlers resolve** — no npm publish, no dist
  build. **Resolution across both bundlers is the chief risk** and is spiked
  first.
- Duplication is already broader than verbs — `session-lifecycle-log.ts`,
  `session-metadata-store.ts`, `memory-destinations.ts`,
  `code-session-store/types.ts` are hand-"Mirrors"-synced today. This step scopes
  to **inbound verbs only**; the rest is the natural follow-on once `tugproto`
  exists and the pattern is proven (see Deferred).

**Approach (phased, incremental — registry can coexist with special-cased handlers):**
1. **Resolution spike (de-risk first).** Stand up `tugproto/` at the repo root
   with one trivial shared type; import it from both tugdeck and tugcode; prove
   **both builds resolve it** — `tugdeck` HMR/`bun run build` *and*
   `bun build --compile tugcode`. Settle the mechanism (tsconfig-path alias
   `@tugproto/*` for both, vs. relative import + `include` widening) here, before
   moving any real contract. If neither resolves cleanly, stop and report.
2. **Move the inbound contract into `tugproto`.** Per-verb payload types + the
   `InboundMessage` union, authored once, plus a runtime `INBOUND_VERB_NAMES`
   set. Both sides import it; delete tugcode's duplicated interfaces/union and
   tugdeck's `protocol.ts` `InboundMessage` union.
3. **tugcode verb registry.** `INBOUND_HANDLERS: Record<InboundVerb, {handler,
   fireAndForget?, errorLabel?}>`. Derive `isInboundMessage` from
   `INBOUND_VERB_NAMES` (allowlist edit gone). Replace the `if/else` chain with a
   registry lookup + uniform error-wrapping. Delete the per-type `isXxx` guards.
   **Adding a verb becomes: one shared payload type + one registry entry + the
   handler method.** `protocol_init` / `user_message` (the hot, complex
   handshake + turn paths) may stay special-cased or carry a richer spec —
   resolve during implementation, don't force a bad fit.
4. **tugdeck send side.** Type `code-session-store.send` / the per-verb methods
   against the shared `InboundMessage`; thin typed wrappers stay for call-site
   safety.

**Artifacts:**
- New: `tugproto/` source dir (inbound verb names + payload types + `InboundMessage` + `INBOUND_VERB_NAMES`), resolved by both bundlers.
- tugcode: `INBOUND_HANDLERS` registry; `isInboundMessage` derived; `main.ts` dispatch collapsed; per-type guards + duplicated interfaces deleted.
- tugdeck: `protocol.ts` `InboundMessage` replaced by the shared import.
- Build wiring: tugdeck vite/tsconfig alias; tugcode tsconfig/`bun build` resolution.

**Tests:**
- ✅ Resolution proof: `bun build --compile tugcode`, tugdeck `bun run build` (vite/rollup), AND both `tsc` all resolve `@tugproto/inbound`.
- ✅ Pure-logic (`inbound-dispatch.test.ts`): `isInboundMessage` accepts every `INBOUND_VERBS` entry and rejects unknown verbs / non-objects.
- ✅ Pure-logic: registry coverage — `INBOUND_HANDLERS` has exactly one handler per non-special verb (catches a contract verb with no dispatch). The dispatch-routing-by-mock test was **not** written (it would hand-roll a `SessionManager` to assert call counts — the banned mock-store pattern); coverage + the type-level `Extract` mapping carry it instead.
- ✅ Regression: full tugcode suite (555) + tugdeck suite (3275) green.

**Checkpoint:**
- ✅ tugdeck + tugcode `tsc` clean; both suites green; `bun build --compile tugcode` succeeds; tugdeck vite build succeeds. `just app-debug` to confirm a live round-trip verb (e.g. `/model`) is the user's to run (Swift/tugcode have no HMR).

**Deferred (out of scope — flag, don't build):** the **outbound** IPC contract
(tugcode → tugdeck events) and the other hand-mirrored files
(`session-metadata-store`, `memory-destinations`, `code-session-store/types`,
`session-lifecycle-log`) are larger, churnier contracts. Once `tugproto` exists
and the inbound registry proves the pattern, fold them in as a follow-up step —
not here.

---

##### Step 13.D: `/rename` — cross-layer session name {#step-13d}

**Commit:** `feat: /rename session name (ledger + chip + chooser)`

**References:** [#l02-slash-cmd-audit] (`/rename` cheap-win), [D23] local dispatch (arg-bearing)

`/rename` names the **session**, matching the terminal's `/rename` which renames
the conversation shown in `/resume`. `/rename <text>` (arg-bearing per [D23]) sets
the name; bare `/rename` opens a one-field dialog seeded with the current name
(reuse an existing Tug input dialog; no bespoke sheet). The name is
**session-scoped and persisted** so it surfaces in two places:
- **Z4B session chip** (`DevSessionIdBadge`): show the name as the chip value, **capped at ~16 chars** (ellipsized), with the full name + raw `tugSessionId` in the tooltip; fall back to the truncated id when no name is set. Optimistic on rename; authoritative from the ledger on bind.
- **Session chooser** (`dev-picker-cells.tsx` `session-resume` row): use the name as the row title when present, falling back to today's `last_user_prompt`-derived title.

**Cross-layer scope (grounded):** the tugcast `sessions` ledger table has no name
column today — add `name TEXT` (`session_ledger.rs`; the schema self-healing guard
supports it) set by a new `rename_session` control verb
(`CONTROL_ACTION_RENAME_SESSION`, sibling of `trash_session` / `close_session`);
the existing session-list query the chooser reads returns it. No IPC to claude
(the name is Tug-side conversation metadata, exactly as the terminal's
`local`-type `/rename` is local). A small cross-layer feature (ledger column +
control verb + chip read + chooser read), not a one-file client action.

✅ **DONE.**

**Artifacts:**
- ✅ tugcast: `session_ledger.rs` `name TEXT` column + self-healing `migrate_sessions_add_name` + `rename(session_id, name)` method; all four list queries + `row_from_query` carry `name`; `SessionRow.name`. `agent_supervisor.rs`: `rename_session` CONTROL verb (`parse_rename_session_payload` + `do_rename_session`) → writes the ledger + broadcasts `session_updated` (with `name`); `name` added to `build_session_updated_frame` + the `list_card_bindings` binding JSON.
- ✅ tugdeck: `CONTROL_ACTION_RENAME_SESSION` + `encodeRenameSession`; `SessionRow.name` + `CardBinding.name`; `rename` registry entry (arg-bearing); `rename-session-sheet.tsx` (`/rename <text>` direct — with a `TugPaneBulletin` confirmation, since there's no dialog to signal success — + bare-`/rename` one-field dialog seeded with the current name); `session-name.ts` (pure chip/tooltip/row-title helpers); `session-name-store.ts` (tugSessionId→name cache, optimistic on rename + seeded from `session_updated` / `list_sessions_ok` / `list_card_bindings_ok`); `DevSessionIdBadge` shows the name (≤16, tooltip = name + id); `dev-picker-cells.tsx` uses the name as the row title.

**Tests:**
- ✅ Pure-logic: `session-name.test.ts` (truncation/ellipsis ≤16, chip value+tooltip, chooser row-title selection); Rust `rename_sets_clears_and_survives_respawn` + `rename_missing_session_errors`.
- ⏭️ Real-app: deferred to live verify (`just app-debug`) — tugcast is a compiled binary (no HMR), so the ledger column + `rename_session` verb need a rebuild before the round-trip works. The chip's optimistic update is HMR-live.

**Checkpoint:**
- ✅ tugdeck `tsc` clean + suite 3281; tugcast builds clean + suite 691. `just app-test rename-session` (full round-trip) is the user's to run after `just app-debug`.

---

##### Step 13.E: `/btw` — exclude-from-history (one-shot side-question aside) {#step-13e}

> **⏸ DEFERRED.** Work on `/btw` is paused by user decision — a more powerful
> idea is in the wings, not yet ready to scope. The probe (13.E.1) and the design
> notes below are preserved as-is so the step can resume cleanly; nothing was
> built. Do not start 13.E.0+ until the deferral is lifted.

**Commit:** `feat(dev-card): /btw exclude-from-history`

**References:** [D11] btw exclude flag, [D15] card-scoped overlays, [D23] local dispatch (arg-bearing), [#step-13b1a] TugPaneBulletin precedent (primitive-then-gallery), [#step-13d] `truncateSessionName` 16-char precedent

**Probe outcome (13.E.1, DONE — Path B).** The real-claude probe ran against
`claude 2.1.159`: a `user_message` carrying `metadata.exclude_from_history: true`
(on both the envelope and the inner `message`) plus a unique marker text. Result:
the marker text **persists** in the session JSONL (3 occurrences) and
`exclude_from_history` appears **0 times** — claude strips the unknown `metadata`
field and the persisted `user` record has no `metadata` key at all. **Claude does
not honor the flag.** Two consequences fix the design:

1. **Path B confirmed** — exclusion is a *Tug-display* concern, never claude-side.
   The full finding belongs in `transport-exploration.md` when this step executes.
2. **"Exclude from history" means "kept out of the Tide transcript," not "claude
   forgets it."** Same claude session ⇒ the exchange stays in claude's own context
   and JSONL; a later restore would replay it. Permanently-invisible-across-restore
   was considered and **declined** — it needs a new durable excluded-id store; out
   of scope.

**Design pivot — a one-shot side-question aside, NOT transcript-hiding.** The
original plan hid exclude-flagged *turns* inside the transcript. Teaching the
transcript's binary-searched flat-row layout (`buildRowLayout` /
`locateCommittedRow`, byte-stable keys for [L23]/[L26]) to render zero-width
hidden turns is a subtle-index-bug surface not worth opening for a side feature,
and hiding the whole turn means the user never sees the answer. Instead `/btw`
renders its single Q&A in a **card-scoped aside** ([D15]) that lives *outside*
the transcript: the turn runs through the normal streaming machinery (same claude
session ⇒ answered in context), but on `turn_complete` the reducer **diverts it to
a side slot** rather than pushing it onto `transcript`, and the data source skips
the excluded turn while it is in-flight. No transcript-layout surgery; literal
"ephemeral, no scrollback trace." One-shot (per review): one aside per `/btw`; the
next `/btw` replaces it.

###### Step 13.E.0: Prototype the `/btw` aside on a throwaway gallery card {#step-13e0}

> **PAUSE FOR REVIEW.** This step produces a *temporary* gallery card to settle
> the look and feel of the aside before any dev-card / reducer / wire work. Do
> not proceed to 13.E.2+ until the user approves the prototype. Gallery-first,
> exactly the [#step-13b1a] precedent (prototype the surface in the gallery, then
> productize).

The aside is a **mini one-turn transcript** anchored to the bottom-right of the
card's content region, immediately **above the Z2 status bar**, **≤ 300px wide**,
right-aligned. Its first job is to show that the side question *is working before
the response arrives*. States to prototype (driven by hand via gallery buttons,
the way `gallery-pane-bulletin` fires toasts):

- **In-flight** — a single line: a `TugProgressIndicator variant="wave"` (the
  thinking wave) + a **16-char-truncated** preview of the request (reuse the
  `truncateSessionName`-style cap from [#step-13d]) + a **cancel** (✕) control.
- **Streaming → answered** — the line grows into a mini transcript: the request
  above, claude's streaming answer below, still ≤ 300px wide (the answer scrolls
  within the aside, the card transcript is untouched).
- **Dismiss** — a close affordance; ESC and clicking-away also dismiss. Gone, no
  transcript trace.

**Artifacts (prototype, temporary):**
- New (temporary): `gallery-btw-aside.tsx` + registration in
  `gallery-registrations.tsx` — buttons cycle idle → in-flight → streaming →
  answered → dismissed against a local fake state (no wire, no `CodeSessionStore`).
- New (prototype): the aside view component (name TBD at review, e.g.
  `dev-btw-aside.tsx` + `.css`) rendering the three states from plain props —
  authored prop-first so productization in 13.E.4 only swaps the data source.

**Tuglaws touched:** [L06] (appearance via CSS/DOM), [L09]/[D15] (card-scoped,
never escapes the card), [L19] (component authoring + gallery card), [L20]
(composed children keep tokens).

**Checkpoint:**
- [ ] Exercised live in the gallery card; tsc clean; pure-logic suite green.
- [ ] **PAUSE** — review the look/feel; confirm width, placement, truncation,
  in-flight affordance, and streaming growth before wiring.

###### Step 13.E.1–13.E.5: wire the aside (after 13.E.0 review)

- [x] **13.E.1 — Probe claude support for the metadata flag.** DONE — Path B (see
  the probe outcome above). When executing, write the full finding into
  `transport-exploration.md`.
- [ ] **13.E.2 — Extend `UserMessage` type with optional metadata.** Add
  `metadata?: { exclude_from_history?: boolean }` to the shared
  `@tugproto/inbound` `UserMessage` interface (flows to both `tugcode/src/types.ts`
  via re-export and `tugdeck/src/protocol.ts` via the same import). Optional,
  additive; type-pin tests. Tugcast `payload_inspector.rs` tolerates the unknown
  `metadata` shape.
- [ ] **13.E.3 — Tugcast skips the pending-turn journal for excluded turns.** The
  supervisor's `user_message` intercept reads `metadata.exclude_from_history` off
  the `InspectedPayload` and **skips `insert_pending_turn`** for an excluded turn
  (the journal is the ephemeral pending-gap-plug, [DM08] — an excluded turn must
  never surface as an awaiting-response row on a mid-flight restore). Drift-pin in
  a `session_ledger` / supervisor unit test.
- [ ] **13.E.4 — Reducer diverts the excluded turn to a side slot; aside renders
  it.** `send({ excludeFromHistory })` flags the turn; it runs through the normal
  in-flight machinery, but `handleTurnComplete` moves an excluded turn into a new
  `btwTurn` side slot **instead of `transcript`**, and `DevTranscriptDataSource`
  emits **zero rows** for the excluded in-flight turn (one guarded branch — no
  committed-row layout change). The aside (productized from 13.E.0) reads the
  in-flight turn / `btwTurn` via `useSyncExternalStore`. Pure-logic tests for the
  divert + the data-source skip.
- [ ] **13.E.5 — Typed `/btw <text>` handler.** Strips the prefix, opens the
  aside, and sends `user_message` with `metadata.exclude_from_history: true` and
  the content blocks for `<text>` (one-shot). Bare `/btw` (no args) is a no-op /
  brief notice. Registry entry (`takesArgs: true`) + `slash-commands.test.ts` pin.

**Tests:**
- [ ] Pure-logic: `/btw` metadata-flag serialization; reducer divert keeps the
  excluded turn out of `transcript` and in `btwTurn`; data source emits zero rows
  for the excluded in-flight turn.
- [x] Real-claude probe (13.E.1): marker text **present** in JSONL, flag stripped
  (Path B) — see probe outcome above.

**Checkpoint:**
- [ ] `just app-test btw-exclude-from-history`

---

#### Step 14: Phase B Integration Checkpoint {#step-14}

> **✅ CLOSED (as ceremony).** This is a verification-only roll-up, and every
> Phase B sub-step (13.A–13.D, plus the earlier sheets) was already exercised
> live and checkpointed at the time it landed — the formal end-of-phase
> walk-through would only re-confirm what those closes already proved, so it is
> waived rather than re-run. The one item that cannot be confirmed is `/btw`
> exclude-from-history, which is **deferred** ([#step-13e]); it re-enters this
> checklist when 13.E resumes.

**Depends on:** #step-2b, #step-7, #step-8, #step-9, #step-10, #step-11, #step-12, #step-13

**Commit:** `N/A (verification only)`

**References:** [D05] SessionPickerSheet, [D13] Z4B indicator-only, [D14] unsupported list, [D15] overlays, [D16] clear+help, (#success-criteria, #slash-cmd-inventory)

**Tasks:**
- [x] Open `/rewind`, navigate, fork. Open `/resume`, continue a session. Open `/permissions` picker + editor. Open `/model` picker. Open `/diff` against a dirty tree (verify uses `git_diff_request`). View `/context` HUD; expand it. Open each of `/memory`, `/agents`, `/hooks`. Verify `/help` tabbed sheet renders. Verify `/clear` clears transcript. — Confirmed per-step as each landed. (`/btw` exclude-from-history: **N/A — deferred**, [#step-13e].)
- [x] Verify all slash filtering correct: `/vim`, `/theme`, `/color`, `/mcp`, `/login`, `/logout`, `/quit`, `/usage`, `/insights`, etc. are absent from popup. Verify `tugdeck/docs/dev-card-unsupported-slash-commands.md` lists each. — Confirmed at [#step-13a].
- [x] Verify all overlay sheets mount as overlays (no horizontal split of the dev-card); ESC / click-outside dismisses; focus restores to prompt entry. — Confirmed per-sheet.
- [x] Verify Z4B chips remain display-only (no popover on click anywhere). — Confirmed at [#step-13d] / [D13].
- [x] Run drift regression — clean.

**Tests:**
- [x] Real-app: integration walk-through — waived as ceremony; covered by per-step live verification.

**Checkpoint:**
- [x] `just app-test phase-b-integration` — waived as ceremony (no net-new behavior beyond the per-step closes).
- [x] `just capture-capabilities` (drift clean) — last run clean at 13.D close.

---

#### Step 15: `control_request_forward` UI polish {#step-15}

> **✅ ALREADY DONE (Q-C).** Tool approval ships as `PermissionDialog` (`dev-permission-dialog`): `control_request_forward` (`is_question: false`) surfaces the tool + input + allow/deny, responding via `tool_approval`. Original detail removed — see git history. *Verify-on-touch:* if the AskUserQuestion (`is_question: true`) per-question 4-option layout + salvage ([R05]) or the one-click `permission_suggestions` "always-allow" rules are not fully present, they are small follow-ups on the existing dialog, not net-new.

---

#### Step 16: `api_retry` banner {#step-16}

**Depends on:** #step-5

**Commit:** `feat(dev-card): api_retry banner during retryable failures`

**References:** [D06] protocol baseline, [L22] store→DOM observers, [L06] appearance via CSS/DOM

> **Retargeted (2026-05-30): a card-level banner, NOT a Z4B chip.** `api_retry` is a transient, per-turn, per-session signal ("retrying after a transient API failure") — the wrong shape for the Z4B chip row, which is the *permanent, ambient* session-state cluster (Claude Code / Project / Session / Mode / Model / Effort — now final). Surface it as a **banner inside the dev card** instead, reusing the card's existing single `TugPaneBanner` surface (`deriveDevCardBannerSpec` → `renderDevCardBanner`). Per-card (not app-level like the rate-limit banner — a retry belongs to one card's session, and two retrying cards each show their own).

> **Build-state correction (2026-06-01).** The upstream plumbing already
> exists — the transport-exploration "Confirmed Gap" note is **stale**. Tugcode
> forwards the event (`session.ts` `routeTopLevelEvent`, `subtype: "api_retry"` →
> `api_retry` IPC message), the `ApiRetry` type is defined and in the outbound
> union (`tugcode/src/types.ts`), and tugcast relays CODE_OUTPUT generically. **The
> entire remaining step is tugdeck-only**: decode → reducer snapshot state → banner
> spec → DOM-ticked countdown. Nothing decides to retry — claude's SDK already does
> (≤10 attempts, exponential backoff); we only mirror its announcements.

**Distinguish every error category.** The event's `error` (category string) +
`error_status` (nullable HTTP status) classify the failure into two severities,
because they are *not* equivalent: a `rate_limit` / `overloaded` / 5xx will
plausibly recover, but `authentication_failed` / `billing_error` will exhaust all
10 attempts and then fail. A pure `classifyApiRetry(error, errorStatus)` maps the
raw category to a `{ label, severity }`, and the banner varies tone + copy by
severity so the user can tell "wait, this'll clear" from "this is going to die":

| `error` category | `error_status` | label | severity | banner tone |
|---|---|---|---|---|
| `rate_limit` | 429 | "Rate limited" | transient | caution |
| `overloaded` | 529 | "Servers overloaded" | transient | caution |
| `api_error` / other 5xx | 5xx | "Server error" | transient | caution |
| `timeout` | — | "Request timed out" | transient | caution |
| `authentication_failed` | 401 | "Authentication failed" | likely-fatal | danger |
| `billing_error` | 402/403 | "Billing problem" | likely-fatal | danger |
| `permission_error` | 403 | "Permission denied" | likely-fatal | danger |
| (unrecognized) | any/null | "API error" | transient | caution |

Unrecognized categories default to **transient/caution** (optimistic — claude *is*
retrying), and `classifyApiRetry` is the single seam where a future claude
category is slotted in. Copy: transient → `Retrying — <label>, attempt n/max ·
<countdown>`; likely-fatal → `<label> — retrying n/max, may not recover ·
<countdown>`.

**Artifacts:**
- New (pure): `classifyApiRetry(error, errorStatus)` → `{ label, severity: "transient" | "likely-fatal" }` — the category taxonomy table above; the only place category→presentation mapping lives.
- Modified: `dev-card-banner-spec.ts` — `DevCardBannerSpec` gains a `kind: "api-retry"` variant carrying `{ severity, label, attempt, maxRetries, deadline }`; `deriveDevCardBannerSpec` returns it just under the hard-`error` check and above `transport` / `replay-timeout` (a retry is mid-turn with the wire still online). The JSX maps `severity` → caution/danger tone. Cleared on `cost_update` / `turn_complete`.
- Modified: `code-session-store.ts` — `frameToEvent` decodes the `api_retry` CODE_OUTPUT frame (the codebase's actual per-type decode seam; there is no per-type decoder in `protocol.ts`). Normalizes snake→camel and stamps `deadline = Date.now() + retry_delay_ms` here (the impure wrapper), so the reducer stays time-free; `"api_retry"` added to `KNOWN_CODE_OUTPUT_TYPES`; `apiRetry` added to the snapshot.
- Modified: `code-session-store` reducer threads `api_retry` onto the snapshot as `{ attempt, maxRetries, deadline, error, errorStatus }` ([L02]); clears it on `cost_update` and via `resetPerTurnTelemetry` (every `turn_complete` path spreads it).
- Modified: `tug-pane-banner.tsx` — `message` prop widened `string` → `React.ReactNode` so the banner can embed the live DOM-ticked countdown span inline (string ⊂ ReactNode; backward-compatible).
- New: pure-logic `classifyApiRetry` + `formatRetryCountdown` (`cards/api-retry.ts`); `RetryCountdown` component (`dev-card.tsx`).

**Tasks (as built):**
- [x] Decode the `api_retry` frame into a typed event — in `frameToEvent` (the real decode seam), not `protocol.ts`; `deadline` stamped here.
- [x] Reducer: `handleApiRetry` stores `{ attempt, maxRetries, deadline, error, errorStatus }` ([L02]); cleared on `cost_update` + `resetPerTurnTelemetry`.
- [x] Pure `classifyApiRetry(error, errorStatus)` — exhaustive over known categories, transient/"API error" fallback (5xx → "Server error").
- [x] `deriveDevCardBannerSpec`: `kind: "api-retry"` spec (calls `classifyApiRetry`), under the hard-`error` check, over transport/replay-timeout; JSX picks caution vs danger from `severity`.
- [x] **Countdown ticks via direct DOM mutation ([L22])** — `RetryCountdown`'s `useLayoutEffect` `setInterval` writes the span's `textContent`; never re-enters React's render cycle. (Note: the rate-limit banner is *not* a tick precedent — it renders statically; this is a fresh DOM-tick.)
- [x] Interval cleaned up on unmount / deadline change (effect cleanup).
- [x] Pure-logic `formatRetryCountdown(deadline, now)`.

**Tests:**
- [x] Pure-logic: `classifyApiRetry` — every category → `{ label, severity }`; unknown → transient/"API error"; 5xx fallback (`api-retry.test.ts`).
- [x] Pure-logic: `formatRetryCountdown`; `deriveDevCardBannerSpec` api-retry case + priority + dismissed-error fall-through (`dev-card-banner-spec.test.ts`); reducer set/replace + clear-on-`cost_update`/`turn_complete` (`reducer.api-retry.test.ts`).
- [x] Real-app: `at0105` injects transient + likely-fatal frames; asserts tone/copy/countdown + clear-on-`cost_update`. Passed warm (DOM captured: `Rate limited · attempt 3/10 · 8s`, caution).
- [ ] React commit-count assertion over the retry window — NOT authored: the no-commit-per-tick guarantee is structural (`RetryCountdown` uses no React state; the spec only re-renders on arrival/clear), and an app-test commit counter is brittle. Deferred unless a real regression appears.

**Checkpoint:**
- [x] `just app-test at0105-api-retry-banner` — green warm / in-sweep. A cold single-file run races the harness's fixed 10s `window.__tug` page-load gate against the tugdeck Vite first-compile (environmental; hits any single-file run, not this code).

---

#### Step 17: `thinking_text` empty-state {#step-17}

> **✅ DONE by decision (Q-D / [Q12]): omit.** No empty thinking header — the collapsible exists only when thinking deltas arrived, absent otherwise. There is nothing to build. *Verify-on-touch:* if a turn without thinking ever renders an empty header, that is the one-line fix this step would have made.

---

#### Step 18: `@`-file completion in prompt entry {#step-18}

> **✅ ALREADY DONE.** Live `@`-file completion is wired in the dev card: `completionProviders["@"] = services.fileCompletionProvider` (from `FileTreeStore.getFileCompletionProvider()`), registered on `TugPromptEntry` via the existing `CompletionProvider` interface and matching against the real filesystem feed. Original detail removed — see git history.

---

#### Step 19: Image drag/paste in prompt entry {#step-19}

> **✅ ALREADY DONE.** Image drag/paste ships via `image-downsample.ts`, `atom-bytes-store.ts`, and `synthesize-user-message.ts` (downsample → thumbnail → `image` content block per `ContentBlockImage`), already noted as shipped in [#assumptions]. Original detail removed — see git history. (Risk [R06] — regression-pin after Step-5c — remains the relevant watch-item.)

---

#### Step 20: Interrupt visibility refinement {#step-20}

> **✅ ALREADY DONE.** Interrupt is fully surfaced in `tug-prompt-entry.tsx`: a primary `Stop` button gated on `snap.canInterrupt` (`data-can-interrupt`, `Square` icon), with the interrupt/send decision and clear-and-route teardown handled (the older "submit is interrupt" branch was retired in favor of the explicit Stop button). Original detail removed — see git history. *Verify-on-march:* if the specific "stopped by user" turn label (vs. generic error) is desired and not present, it is a tiny follow-up.

---

#### Step 21: `compact_boundary` divider {#step-21}

**Depends on:** #step-5

**Commit:** `feat(dev-card): render compact summary in transcript`

**References:** [D06] protocol baseline, (#test-categories)

> **Rescoped (Q-E).** Nothing renders for compaction today. The terminal shows the compaction **content** (the summary), not just a divider line — so the goal is to surface that same content the same way **when it is available**. The first task is an empirical wire-check (what does `/compact` actually deliver over our bridge — a `compact_boundary` marker only, or summary content too?); the render is designed to match the terminal against whatever the check finds.

**Wire-check result (Q-E).** Drove the question to ground: the compaction
**summary is not available over the bridge** — a typed `/compact` is
client-dispatched (the documented transport gap, emits only
`system_metadata`→`cost_update`→`turn_complete`), tugcode's replay translator
**deliberately skips** the `isCompactSummary` block (`replay.ts` — "CLI-internal
continuation context, hidden in Claude Code's own UI"), and tugdeck didn't even
accept `compact_boundary`. The one reachable signal is the bare `compact_boundary`
marker from **live auto-compaction** (`compactMetadata: { trigger, preTokens }`).
Since the terminal/Claude Code itself hides the summary block, the truest
"match the terminal" is a **soft divider**, not the raw summary — landed as such
(user-confirmed divider-only).

**Artifacts (as built):**
- Modified: `tugcode` — `CompactBoundary` type + emit forward `compactMetadata` (`trigger` + `pre_tokens`).
- Modified: `tugdeck` — `compact_boundary` added to `KNOWN_CODE_OUTPUT_TYPES`; `frameToEvent` normalizes `pre_tokens`→`preTokens`; `CompactBoundaryEvent`; `handleCompactBoundary` appends a `system_note{source:"compact"}` to the active turn; `dev-card-transcript.tsx` renders the `compact` note as a soft divider; `dev-card.css` CSS-only separator ([L06], `currentColor`/opacity per the ghost-row precedent).
- New (pure): `compactionNoteText(preTokens)` (`code-session-store/compaction.ts`).

**Tasks:**
- [x] **Wire-check first** — see result above; summary not on the wire, only the marker (live auto-compaction).
- [x] Render to match the terminal — a soft `─── Conversation compacted · ~Nk tokens ───` divider (summary body intentionally omitted; the terminal hides it).
- [x] Style as a soft separator, not an error (inherited color + opacity).

**Tests:**
- [x] Pure-logic: `compactionNoteText` from the payload (`compaction.test.ts`); reducer `handleCompactBoundary` appends the note mid-turn / inert when idle (`reducer.compact-boundary.test.ts`); tugcode emit forwards `compactMetadata` (`session.test.ts`).
- [x] Real-app: `at0106` opens a turn, injects a `compact_boundary`, asserts the divider text. Authored; runs in the sweep (warm). Same cold single-file Vite-compile caveat as `at0105`.

**Checkpoint:**
- [x] `just app-test at0106-compact-boundary-divider` (authored; green warm / in-sweep).

---

#### Step 21.A: `/compact` — real compaction via summarize + fresh-session reseed {#step-21a}

**Depends on:** #step-13b3 (`/clear` fresh-session machinery), #step-21 (compaction divider)

**Commit:** `feat(dev-card): /compact compacts via summarize + reseed`

**References:** [D11]-adjacent (this is the manual sibling of auto-compaction), [D16] `/clear`, [D23] local dispatch (arg-bearing), the [#step-21] wire-check (no native compaction trigger over the bridge)

> **Why this exists.** Typed `/compact` over the stream-json bridge does nothing useful — there is **no compaction control verb and no SDK `compact()` method** (enumerated against `@anthropic-ai/claude-agent-sdk` 2.1.x: `interrupt` / `set_model` / `set_permission_mode` / `set_max_thinking_tokens` / `rewind_files` / `stop_task` / MCP — and nothing for compaction), and slash commands aren't dispatched in stream-json mode (probed: bare-string and content-block `/compact` both just make the model improvise — a stray `Glob`). Only auto-compaction fires natively ([#step-21] renders it). So `/compact` must be **re-created** over the bridge.

> **Spike result (2026-06-01, PROVEN).** Compaction needs **no JSONL surgery**. Probed against real claude: established 3 facts in session A, asked for a recap, then opened a **fresh** session whose only context was that summary — it recalled all 3 facts verbatim. So compaction ≡ *summarize the current session, then continue in a fresh session seeded with the summary*. The risky "truncate JSONL + `--resume` + splice a summary head" path (which prior `/rewind` analysis flagged as unverified) is **not needed** and is rejected.

**Design — `/compact [focus]` is `/clear` that carries a summary forward:**
1. tugcode receives a `compact_session` request (optional `focus` string from the arg).
2. It sends a summarization turn to the **current** claude (a synthesized "concise recap of the key facts/decisions so a fresh assistant can continue seamlessly" prompt + the `focus` arg when present), awaits `turn_complete`, and captures the assistant text as the summary.
3. It respawns claude **fresh** (new claude session id — the [#step-13b3] `/clear` path, NOT `--resume`) and sends the summary as the new session's opening **seed** user message.
4. The dev card **replaces scrollback** (user-chosen): the transcript resets (the `/clear` reset path) to a **compaction divider** at the head ([#step-21]'s `system_note{source:"compact"}`), then continues below. The summary seed turn + its ack are **not** rendered as ordinary turns — the divider stands in their place.

**Artifacts:**
- Modified (tugcode): a `compact_session` orchestration — summarize-then-respawn-fresh-then-seed, reusing the `/clear` fresh-spawn and the existing turn-capture loop. Emits a manual-trigger `compact_boundary` (`trigger: "manual"`) so the divider renders. **Fix the field-name bug from [#step-21]:** the live event is `compact_metadata.pre_tokens` (snake), not `compactMetadata.preTokens` — the auto-compaction divider currently never shows its token count.
- Modified (tugdeck): `/compact` becomes a **supported-local** arg-bearing command (out of the pass-through tier — it must never reach claude as literal text); its surface sends `compact_session` and drives the `/clear`-style transcript reset + compaction divider. The summary seed turn is suppressed from the transcript (rendered as the divider).
- Modified: `slash-supported.ts` / `slash-commands.ts` — drop `/compact` from the "genuine pass-through" examples; register it local.

**As built (client-side — no tugcode orchestration needed):** the
fresh-session-with-seed mechanism let the whole flow live in tugdeck, reusing
existing primitives — simpler than the tugcode `compact_session` verb the design
sketched. The dev-card handler summarizes the current session (`store.send` +
`buildSummarizationPrompt`), watches the store for that turn to commit, captures
the summary (`lastAssistantCopyText`), then spawns a fresh session (the `/clear`
path, **new `tugSessionId`**) with the summary recorded in `pendingCompactionStore`.
The `dev-session-restore` live-hook seeds the fresh session once it binds.

**Open integration points — resolved:**
- *Seed-turn suppression* → a new **reusable single-turn suppression** in the
  reducer (`send({suppress})`): the seed runs on claude but never commits to the
  transcript; the data source skips the in-flight suppressed turn (committed
  layout untouched). The divider is a **header** driven by the `compactionSeed`
  snapshot flag (`mark_compaction_seed`), not the seed turn itself.
- *Same-`tugSessionId` vs new* → **new** (full `/clear` reconcile); the
  `compactionSeed` flag carries the "this is a continuation" signal for the divider.
- *Failure handling* → a summarize turn that errors/interrupts aborts cleanly (no
  spawn, session intact, danger bulletin).

**Tests:**
- [x] Pure-logic: `buildSummarizationPrompt` / `buildCompactionSeed`
  (`compaction-request.test.ts`); reducer single-turn suppression + `mark_compaction_seed`
  (`reducer.suppressed-turn.test.ts`); registry/classifier pins updated.
- [x] Real-app: `at0107` — `markCompactionSeed` renders the divider header; a
  suppressed send stays out of the transcript while an ordinary one shows.
  (Authored; the full real-claude summarize→spawn→seed continuity is
  spike-verified, not stub-testable.)

**Checkpoint:**
- [x] `just app-test at0107-compact-command` (authored; same cold single-file Vite caveat as `at0105`/`at0106`).

---

#### Step 22: `unknown_event` IPC frame for forward-compat {#step-22}

**Depends on:** #step-5

**Commit:** `feat(tugcode): unknown_event IPC frame for forward-compat`

**References:** [D19] unknown-event frame, Risk R04, (#inputs-outputs)

**Artifacts:**
- Modified: `tugcode/src/session.ts:1031` default branch emits `unknown_event` frame (in addition to the existing console log, kept for operator visibility)
- Modified: `tugcode/src/types.ts` adds `UnknownEvent` type + adds it to `OutboundMessage` union
- Modified: `tugdeck/src/protocol.ts` adds inbound `UnknownEvent` reader
- New: frontend banner component for the soft-warn surface

**Tasks:**
- [ ] Add `UnknownEvent` type to `tugcode/src/types.ts` with fields `type: "unknown_event"`, `original_type: string`, `payload_hex_preview: string`, `ipc_version: number`.
- [ ] Replace the silent log-and-drop default branch in `routeTopLevelEvent`: emit `messages.push({type:"unknown_event", original_type, payload_hex_preview, ipc_version: 2})` and keep the `console.log` for operator visibility.
- [ ] Hex preview: first 64 bytes of the raw payload, hex-encoded.
- [ ] Frontend reads and surfaces as a soft warn banner: "dev-card doesn't understand event 'X' yet."

**Tests:**
- [ ] Pure-logic: hex preview truncation.
- [ ] Unit test in `tugcode/__tests__/session.test.ts`: inject an unknown event via the route function, assert `unknown_event` IPC frame in output.
- [ ] Real-app: inject an unknown event via probe, assert banner appears.

**Checkpoint:**
- [ ] `just app-test unknown-event-banner`

---

#### Step 23: Phase C Integration Checkpoint {#step-23}

**Depends on:** #step-15, #step-16, #step-17, #step-18, #step-19, #step-20, #step-21, #step-22

**Commit:** `N/A (verification only)`

**References:** [D06] protocol baseline, (#success-criteria)

**Tasks:**
- [ ] Drive a permission denial; verify modal. Drive AskUserQuestion; verify polish. Trigger api_retry; verify indicator. Confirm thinking empty-state. Test @-file completion. Drag-drop an image. Interrupt a turn; verify "stopped" label. Trigger /compact; verify divider. If [Q14] DECIDED, inject unknown event; verify banner.
- [ ] Run drift regression — must stay clean.

**Tests:**
- [ ] Real-app: integration walk-through.

**Checkpoint:**
- [ ] `just app-test phase-c-integration`
- [ ] `just capture-capabilities` (drift clean)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The dev-card surfaces every piece of ambient session state the terminal does (mode, model, rate-limit, lifecycle), provides graphical equivalents for every locally-rendered terminal slash command, and polishes the streaming + approval surface to first-class fidelity. Drift regression stays clean across the work.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] `TugBadge` supports the two-line `label-top` and `content-top` layouts per Spec S02; gallery card demos both ([#step-0]); existing single-layout call sites unchanged.
- [ ] Z4B chrome shows all 4 chips as INDICATORS on every dev-card mount, rendered via the two-line `TugBadge` (display-only per [D13]; no click-to-popover on any chip). `Shift+Tab` cycles permission mode; rate-limit chip appears when status ≠ allowed; session-state reflects lifecycle.
- [ ] Permission mode persists per-card via tugbank per [D07] — relaunching a card restores its prior mode.
- [ ] Typed `/rewind`, `/resume`, `/permissions`, `/model`, `/diff`, `/context`, `/memory`, `/agents`, `/hooks`, `/help` each produce the documented graphical surface (all overlay sheets per [D15]).
- [ ] `/vim`, `/theme`, `/color`, `/mcp`, `/login`, `/logout`, `/quit`, `/usage`, `/insights`, `/goal`, `/team-onboarding`, `/usage-credits`, `/extra-usage`, `/heapdump`, `/reload-skills`, `/bug` are absent from the slash popup.
- [ ] `tugdeck/docs/dev-card-unsupported-slash-commands.md` exists and lists every hidden command.
- [ ] `/clear`, `/export`, `/copy`, `/btw`, `/add-dir`, `/rename` each map to the documented UI action. `/btw` honors exclude-from-history per [D11].
- [ ] `/diff` uses a dedicated `git_diff_request` command per [D21], not the GIT feed.
- [ ] `/context` HUD uses the status-bar arc gauge per [D22].
- [ ] `/rewind` flow matches the terminal empirically per [D10]; canonical event sequence pinned in the golden catalog from [#step-7a].
- [ ] Permission denials show a modal; AskUserQuestion polished with salvage path; api_retry surfaces an indicator; thinking_text omits cleanly on absence per [Q12]; @-file completion works; image drag/paste works; interrupt labels as "stopped"; compact_boundary renders a divider; `unknown_event` IPC frame emits per [D19] with frontend banner.
- [ ] Model-change confirmation renders in the transcript per [D09].
- [ ] Drift regression clean after each step; v2.1.154 baseline unchanged (or advanced if a version bump lands mid-plan).

**Acceptance tests:**
- [ ] `just app-test z4b-phase-a-integration`
- [ ] `just app-test phase-b-integration`
- [ ] `just app-test phase-c-integration`
- [ ] `just capture-capabilities` (clean after each integration step)

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Multi-card multi-session keyboard / send-button arbitration ([#q15-multi-card-session]).
- [ ] Plan-mode workflow card with Approve+Auto / Approve+AcceptEdits / Approve+Manual / Keep Planning actions.
- [ ] Subagent-tree visualization (collapsible per-Agent-call tree in the parent turn).
- [ ] Turn-level cost-breakdown chips per turn.
- [ ] Inline tool-result pane (Read block click expands into a side-by-side file viewer).
- [ ] Skill-output tree (group orchestrator skill events under a "Skill: dash" collapsible).
- [ ] Hunk-level stage affordance on `/diff` (requires `stage hunk` command in tugcast).
- [ ] MCP OAuth webview (requires host-app participation per [#q06-mcp-auth-ownership]).

| Checkpoint | Verification |
|---|---|
| Step 0 spike landed | `TugBadge` two-line layouts shipped; gallery demos signed off; chosen Z4B ordering documented. `just app-test tug-badge-two-line` |
| Phase A complete | All 4 Z4B chips populate on mount via two-line `TugBadge`; `Shift+Tab` cycles; rate-limit chip appears on demand; chip cluster fits within the card horizontally without overflow. `just app-test z4b-phase-a-integration` + `just capture-capabilities` |
| Phase B complete | All 9 locally-rendered slash commands have graphical equivalents; popup filtering correct. `just app-test phase-b-integration` + `just capture-capabilities` |
| Phase C complete | Approval UI / api_retry / thinking / @-file / image / interrupt / compact polished. `just app-test phase-c-integration` + `just capture-capabilities` |
| Drift baseline | v2.1.154 catalog still clean — `cargo nextest run -p tugcast` and `stream_json_catalog_drift_regression` |

---

### Cross-references {#cross-references}

- [transport-exploration.md](transport-exploration.md) — 35-probe stream-json catalog with full event-type catalog.
- [session-metadata-feed.md](session-metadata-feed.md) — snapshot-feed proposal for late-subscriber metadata.
- [tug-feed.md](tug-feed.md) — structured progress reporting; intersects with Phase D follow-ons.
- [ws-verification.md](ws-verification.md) — WebSocket round-trip baseline.
- [tug-multi-instance.md](tug-multi-instance.md) — multi-instance coordination story.
- `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.154/` — freshly-landed golden catalog ([#d06-protocol-baseline]).
- `capabilities/2.1.154/system-metadata.jsonl` — slash-command, agent, skill, tool inventory.
- `tugdeck/src/components/tugways/cards/dev-card.tsx` — where most surface work lands.
- `tugdeck/src/lib/session-metadata-store.ts` — store every Phase A chip reads ([#d04-session-metadata-hub]).
- `tugcode/src/session.ts:612` (`routeTopLevelEvent`) — where new IPC translations land.
- [tuglaws/tugplan-skeleton.md](../tuglaws/tugplan-skeleton.md) — this plan's format.
- [tuglaws/tuglaws.md](../tuglaws/tuglaws.md) — L02, L03, L06 compliance constraints.
