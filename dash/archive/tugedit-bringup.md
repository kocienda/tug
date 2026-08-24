<!-- devise-skeleton v4 -->

## tugedit Bring-up — Shell Capability Ladder (Rungs 1–2) + a bbedit-style Editor CLI {#tugedit-bringup}

**Purpose:** Ship `tugedit`, a Rust command-line tool that opens files for editing inside a running Tug.app (bbedit-style, including a blocking `--wait`), and make `git commit` edit its message in Tug instead of BBEdit. Getting there requires two rungs of the shell "capability ladder": remove the arbitrary per-command reap so a blocking editor handoff isn't killed (rung 1), and give a parked-on-editor shell exchange a distinct state (rung 2). Block mode stays the default.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-11 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Dev card's `$` route runs shell commands in a **block-oriented, pipe-mode** model (`tugrust/crates/tugcast/src/feeds/shell.rs`): each command is a discrete exchange (command in → output block out, with an exit code and cwd-after), persisted to `ShellLedger` and interleaved with Claude turns in the transcript. This model is correct for the Dev card's identity as a transcript, but it deliberately gives up interactivity: with no controlling TTY, anything that blocks on a terminal (a `git commit` editor, a password prompt, a REPL) can't be driven. Today the shell also imposes a **120-second wall-clock reap** (`EXEC_TIMEOUT`, `shell.rs`) on every exchange — an arbitrary cap that kills long-but-active builds and would kill a blocking editor handoff outright.

Separately, `git commit` currently opens the message in BBEdit because the user's `~/.gitconfig` sets `core.editor = bbedit --wait --resume`. We want that edit to happen in Tug. The clean way to offer this (and other "open a file in Tug from the shell" conveniences) is a small CLI, `tugedit`, modeled on bbedit's command-line tool — line/column addressing, `--wait`, `--create` — that hands a file to the running Tug.app and (in `--wait` mode) blocks until the user is done. The deck already has almost everything needed: an `open-file` CONTROL action (`openFileInCard`, `tugdeck/src/action-dispatch.ts`) that opens a path in a Text card with path-keyed reuse, and tugcast already has the exact blocking round-trip we need in `/api/eval` ↔ `eval-response` (a pending-oneshot map resolved by a later action). This plan composes those existing pieces rather than inventing new transport.

#### Strategy {#strategy}

- **Keep block mode the default.** This plan does not add a PTY, a terminal emulator, or a long-running tunnel. It removes an arbitrary cap and adds one narrow, non-terminal editor handoff.
- **Rung 1 first (unblocks everything):** delete the wall-clock `EXEC_TIMEOUT`; the existing out-of-band `kill` frame is the user's stop control. This is what makes a blocking `tugedit --wait` (and long builds) safe.
- **Reuse existing transport:** `tugedit` talks to tugcast over **loopback HTTP** (like `tugutil host tell`), and the `--wait` round-trip mirrors `/api/eval` (a `pending_edits` oneshot map resolved by an `edit-done` action). No WebSocket, no auth token, no new feed.
- **Reuse existing deck UI:** the editor is the existing Text card (`openFileInCard`); the handoff just seeds a request id and reports closure.
- **Rung 2 is deck-only polish:** a "parked on editor" exchange state is rendered from the deck's shell store, driven by the same round-trip — no wake-up plumbing back into the blocked shell task.
- **Fail loud, never silently elsewhere:** if Tug isn't reachable or no window is connected, `tugedit` exits non-zero so `git commit` aborts (the user retries), rather than silently editing in a fallback.
- **Ship the git wiring last,** behind a `tugedit install-git` subcommand, after the handoff is proven end-to-end.

#### Success Criteria (Measurable) {#success-criteria}

- A shell command that runs longer than 120s while producing output (e.g. a slow build) in the `$` route **no longer settles with a null exit code at 120s** — it runs to completion. (Drive a `sleep 5 && echo done`-style long-runner with the production dispatcher and assert a real exit code; the removed cap is covered by the reframed unit tests.)
- From a normal terminal, `tugedit --wait <path>` opens `<path>` as a Text card in the running Tug.app and the process **blocks until that card is closed**, then exits 0. (App-test or manual: open, edit, close, observe exit.)
- With `git config --global core.editor` pointed at `tugedit --wait`, `git commit` (run in a normal shell) opens `COMMIT_EDITMSG` in Tug, blocks, and on close **the commit is created with the edited message**. (Integration checkpoint.)
- `tugedit` with no running Tug instance exits **non-zero within ~1s** with a clear message; `git commit` aborts cleanly. (Unit/integration.)
- While a `$`-route `git commit` is parked on its editor, its transcript row shows a distinct **"editing in Tug…"** state, not a bare spinner. (Deck render, rung 2.)

#### Scope {#scope}

1. **Rung 1:** remove `EXEC_TIMEOUT` (wall-clock) from the production shell dispatcher; convert the test-injectable timeout to an *idle* timeout used only by tests; reframe the affected unit tests.
2. Inject the running tugcast port **and the session's `tug_session_id`** into the `$`-route shell child's environment so `tugedit` (and git under it) can find the instance and identify the originating exchange. (Neither exists today — nothing anywhere sets a `TUG_SESSION_ID` env var.)
3. tugcast: a `POST /api/edit` endpoint + a `pending_edits` oneshot map + an `edit-done` resolution action; extend the `open-file` CONTROL frame with `wait` / `requestId` / `tug_session_id`.
4. A new `tugedit` Rust crate: clap CLI (`[+line[:col]] <file>`, `path:line[:col]`, `--wait`), loopback-HTTP client, port resolution (injected env → registry), and `install-git` / `uninstall-git` / `doctor` subcommands.
5. Deck: honor wait-mode `open-file` — open a dedicated Text card, and on close **flush then report `edit-done`**.
6. **Rung 2:** deck-side "parked on editor" state for the in-flight shell exchange of the handoff's `tug_session_id`.
7. git integration: `tugedit install-git` writes `core.editor`; add `tugedit` to the build/bundle bin lists.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No PTY allocation, no terminal emulator, no long-running duplex shell tunnel (rungs 3–4 of the ladder). Interactive programs (`vim`, `htop`, password prompts) are still unsupported here.
- No stdin piping (`git diff | tugedit`) or `--pipe-title` in v1 (see [Q02]).
- No `--create` in v1. tugcast's `/api/fs/write` only creates **missing** files whose parent is under a Tug-owned root (`fs_write.rs`, `drafts_root()` / `asides_root()`); creating arbitrary new files from `tugedit` would open a card that fails at save time. v1 requires an existing file — git's `COMMIT_EDITMSG` always exists. Supporting `--create` needs an `fs_write` posture change (follow-on).
- No `/usr/local/bin` symlink installer for `tugedit` beyond what the existing Justfile `~/.local/bin` symlink loop already provides (see [Q03]).
- No change to the Text card editor itself, its save modes, or its conflict UX.
- No fallback-to-terminal-editor behavior when Tug is unreachable (fail loud instead).

#### Dependencies / Prerequisites {#dependencies}

- A running Tug.app / tugcast instance with a connected deck (browser/WKWebView) for the handoff to complete.
- `tugcore::registry` (`find_by_id`, `find_for_cwd`, `list_live`) for port discovery from an external terminal — the same functions `tug`'s `resolve_port` uses (`tugrust/crates/tug/src/commands/tell.rs`).
- The existing `/api/eval` pending-oneshot pattern (`tugrust/crates/tugcast/src/server.rs`, `router.pending_evals`, and the `eval-response` arm in `tugrust/crates/tugcast/src/actions.rs`) as the template.

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** (`tugrust/.cargo/config.toml`, `-D warnings`). Rust builds/tests fail on any warning.
- tugcast HTTP is **loopback-only**; `/api/edit` must reject non-loopback connections exactly like `tell_handler` / `eval_handler` (`server.rs`).
- Tugdeck laws: external state enters React via `useSyncExternalStore` only ([L02]); lifecycle registrations in `useLayoutEffect` ([L03]); appearance via CSS/DOM, not React state ([L06]). Cross-check `tuglaws/tuglaws.md` before deck work.
- `tugedit`'s `--wait` HTTP request must use **no (or a very long) read timeout** — editing is unbounded — unlike `tugutil host tell`'s default ureq timeouts.
- Never commit AI attribution; commit style follows `/tugplug:commit`.

#### Assumptions {#assumptions}

- The `$`-route shell child inherits tugcast's process environment (it does — `spawn_shell_child` in `shell.rs` does not clear env), so `TUG_INSTANCE_ID` is already visible to descendants. The live port and the per-session `tug_session_id` are NOT in the environment today and must be injected explicitly (Step 2) — no `TUG_SESSION_ID` exists anywhere in the tree.
- git invokes `core.editor` with a single file path and waits for the process to exit before reading the file back — the standard contract `bbedit --wait` already satisfies.
- In the user's normal shell, `GIT_EDITOR` is unset (it is only `true` inside this Claude Code harness env), so `core.editor` governs. See [P07].
- Closing a Text card flushes its buffer to disk (automatic mode autosaves and flushes on unmount; manual mode prompts save-on-close) — so "card closed" implies "file on disk", provided the flush is awaited before `edit-done` (see [P05]).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; steps carry `**References:**` and `**Depends on:**` lines citing anchors and plan-local `[P##]` decisions.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should production keep any automatic reap backstop? (DEFERRED) {#q01-idle-backstop}

**Question:** After removing the 120s wall-clock cap, should the production dispatcher keep *any* automatic reap — e.g. an idle-output watchdog that fires only after N seconds of no output — or is the user-driven `kill` the sole stop control?

**Why it matters:** With no backstop, a genuinely wedged silent command (a pipe-inheriting daemon that holds stdout open, or a TUI that renders then blocks on input) wedges the session until the user hits kill. A wall-clock cap was the old, hated answer; an idle watchdog is a gentler one but is still a number the user didn't ask for.

**Options (if known):**
- Production `None` (no automatic reap; `kill` only) — purest match to the user's stated philosophy.
- Production idle watchdog with a generous, documented backstop, reset on every output line.

**Plan to resolve:** Ship rung 1 with production `None` and the injectable idle timeout used by tests only (see [P02]). Revisit if wedged-session reports appear in practice.

**Resolution:** DEFERRED — production ships with no automatic reap ([P02]); an idle backstop can be added later without touching the wire contract.

#### [Q02] stdin piping and `--pipe-title` (DEFERRED) {#q02-stdin-piping}

**Question:** Should `tugedit` support `git diff | tugedit` (read stdin into a new untitled/temp card) and bbedit's `--pipe-title`?

**Why it matters:** It's a genuinely useful bbedit affordance, but `open-file` opens *paths*, not content — supporting it means either a temp-file dance or a new content-injection path in the deck.

**Resolution:** DEFERRED to a follow-on. v1 requires a file path argument.

#### [Q03] `tugedit` on PATH vs. absolute `core.editor` (DECIDED — see [P07]) {#q03-path-install}

**Question:** How does git find `tugedit`?

**Resolution:** DECIDED. `tugedit install-git` writes an **absolute path** to `core.editor` (robust regardless of PATH). The existing Justfile symlink loop (`~/.local/bin`) also puts `tugedit` on PATH for interactive use. A `/usr/local/bin` installer is out of scope.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| No deck connected → `tugedit --wait` hangs forever | med | med | Server fast-fails when CONTROL has 0 receivers (R01) | Hang reports |
| `edit-done` fires before disk flush → git reads stale message | high | med | Await flush before posting `edit-done` (R02, [P05]) | Wrong commit message observed |
| Removing the cap lets a wedged silent command hang the session | med | low | `kill` button is the stop control; [Q01] backstop deferred | Wedged-session reports |
| External terminal targets the wrong / ambiguous Tug instance | med | low | Registry resolution mirrors `tug`; ambiguous → error (R04) | Multi-instance misfires |

**Risk R01: No connected deck** {#r01-no-deck}
- **Risk:** `tugedit --wait` posts `/api/edit`, but no browser/WKWebView is subscribed to CONTROL, so the `open-file` frame is dropped and `edit-done` never arrives.
- **Mitigation:** In the `/api/edit` handler, if the CONTROL broadcast has `receiver_count() == 0`, return an error immediately; `tugedit` exits non-zero. Also apply a generous absolute backstop timeout on the wait (e.g. hours) so a deck that disconnects *mid-edit* eventually releases the request.
- **Residual risk:** A deck that reloads mid-edit orphans the request until the backstop; the user can hit the `$`-route kill button to reap git.

**Risk R02: Flush/close ordering** {#r02-flush-ordering}
- **Risk:** git reads `COMMIT_EDITMSG` the instant `tugedit` exits; if `edit-done` is posted before the Text card's buffer reaches disk, git commits a stale message.
- **Mitigation:** The wait-mode close path sequences `store.flush()` (normal fetch, not keepalive) strictly before `POST /api/tell {edit-done}` via a promise chain ([P05]) — card close is an in-page unmount, so the chain runs to completion; a page reload never runs cleanups, so it can't false-fire.
- **Residual risk:** A crash between flush and exit — same window any editor has.

**Risk R04: Instance ambiguity from an external terminal** {#r04-instance-ambiguity}
- **Risk:** With several Tug instances running, a `tugedit` invoked outside the `$` shell can't tell which to target.
- **Mitigation:** Resolution order (Spec S05) mirrors `tug`: explicit `--port`/`--instance`, then `TUG_TUGCAST_PORT` (injected inside `$`), then registry `TUG_INSTANCE_ID`/cwd/sole; ambiguous → error listing instances.

---

### Design Decisions {#design-decisions}

#### [P01] Block mode stays the default; this plan adds no terminal layer (DECIDED) {#p01-block-default}

**Decision:** The editor handoff is a non-terminal, out-of-band interaction. No PTY, emulator, or duplex tunnel is added; the `$` route remains block-oriented.

**Rationale:**
- The Dev card is a transcript; block mode is the right primitive for it. The `tugedit` use-case needs none of the terminal machinery — git only needs its editor subprocess to block and return.
- Keeps this plan small and reversible.

**Implications:** Interactive TTY programs remain unsupported (a later rung-3 project). `tugedit`'s block is achieved by an HTTP long-poll, not by a controlling terminal.

#### [P02] Rung 1 = remove the wall-clock reap; `kill` is the stop control; idle timeout is test-only (DECIDED) {#p02-rung1-timeout}

**Decision:** Delete the 120s `EXEC_TIMEOUT` wrapping in the production shell dispatcher. Change the injectable dispatcher timeout from a total-wall-clock `Duration` to an **`Option<Duration>` idle timeout** that production passes as `None` and tests pass as a short value; when `Some`, it reaps only after that many seconds with **no output** (reset on each output line).

**Rationale:**
- The wall-clock cap kills long-but-active commands and would kill a blocking `tugedit --wait`. It is exactly the arbitrary limit the user objected to.
- The out-of-band `kill` frame (`shell.rs`, `reap_group`) already gives the user a real stop button — the cap is largely redundant with it.
- Tests still need determinism (e.g. "a wedged `vim` gets reaped"); an *idle* timeout preserves that without a streaming command tripping it.

**Implications:** `run_dispatcher` / `shell_session_task` / `run_command` signatures change (`exec_timeout: Duration` → `idle_timeout: Option<Duration>`). The `interactive_tui_is_reaped_by_the_timeout` test is reframed as reaped-by-idle (or reaped-by-kill). Production has no automatic time-based reap ([Q01]).

#### [P03] The editor handoff reuses the `/api/eval` pattern — a new `/api/edit` endpoint + `edit-done` (DECIDED) {#p03-edit-endpoint}

**Decision:** Add `POST /api/edit` and a `pending_edits` oneshot map on `FeedRouter`, resolved by a new `edit-done` action arm in `dispatch_action`. Do **not** add a new feed or a WebSocket path.

**Rationale:**
- `/api/eval` already implements exactly this shape (register oneshot by `requestId`, broadcast a CONTROL frame to the deck, await the deck's resolving action) — `server.rs` `eval_handler` + `actions.rs` `eval-response`. Mirroring it is minimal and battle-tested.
- Loopback HTTP needs no auth token (unlike the WS path), so an external CLI connects trivially.

**Implications:** `dispatch_action` gains a `pending_edits` parameter alongside `pending_evals`; `build_app` registers the `/api/edit` route.

#### [P04] `tugedit` reaches tugcast over loopback HTTP; port via injected env then registry (DECIDED) {#p04-transport}

**Decision:** `tugedit` is an HTTP client to `http://127.0.0.1:<port>/api/edit` and `/api/tell`. Port resolution order per Spec S05.

**Rationale:** Matches `tugutil host tell` (`ureq` POST to `/api/tell`), reuses `tugcore::registry` discovery, and needs no cookie/token.

**Implications:** `tugedit` depends on `ureq`, `clap`, `serde_json`, `tugcore`. Inside the `$` route, resolution is a direct env read (Step 2 injects `TUG_TUGCAST_PORT`, and `TUG_SESSION_ID` for the rung-2 parked marker); outside, it walks the registry and sends no `tug_session_id`.

#### [P05] Completion = wait-mode card closed AFTER an awaited flush; no-deck fast-fails (DECIDED) {#p05-completion}

**Decision:** The `--wait` request resolves when the wait-mode Text card is closed. The deck's close path **sequences `store.flush()` strictly before** posting `edit-done` (a promise chain in the effect cleanup — cleanups can't `await`). If no deck is connected, `/api/edit` returns an error immediately.

**Rationale:** git reads the file the moment `tugedit` exits (R02). Fast-failing on no-deck avoids an indefinite hang (R01).

**Implications:** The wait-mode card carries its `requestId` (seeded via the open payload) and owns the flush-then-report on close.

#### [P06] Rung 2 "parked" state is deck-only, driven by the same round-trip (DECIDED) {#p06-parked-deck-only}

**Decision:** The "editing in Tug…" exchange state lives entirely in the deck's shell-session store. The wait-mode `open-file` frame carries `tug_session_id`; the deck marks that session's in-flight shell exchange parked; `edit-done` clears it. No signal is pushed back into the blocked shell task.

**Rationale:** With rung 1 removing the production timeout, the shell task doesn't need to know it's parked (nothing reaps it). Keeping parking deck-side avoids waking a task that is blocked reading the child's stdout, and it obeys [L02] (render from the store).

**Implications:** A small addition to `shell-session-store.ts` (a `parked` flag on the in-flight exchange) and its row renderer. No `shell.rs` change beyond rung 1 + env injection.

#### [P07] git integration sets `core.editor` to an absolute `tugedit --wait` (DECIDED) {#p07-git-wire}

**Decision:** `tugedit install-git` runs `git config --global core.editor "<abs-path-to-tugedit> --wait"` (and `uninstall-git` restores/removes it). It does not touch `GIT_EDITOR`.

**Rationale:** Absolute path is robust regardless of PATH. `core.editor` is what the user's `~/.gitconfig` already uses (`bbedit --wait --resume`); replacing it is the least surprising change. `GIT_EDITOR`, when set, overrides `core.editor` — but in the user's normal shell it is unset, so `core.editor` governs.

**Implications:** `install-git` must resolve its own absolute executable path (`std::env::current_exe`). Document the `GIT_EDITOR` precedence caveat.

---

### Deep Dives {#deep-dives}

#### End-to-end flow: `git commit` in the `$` route → edit in Tug → commit {#flow-git-commit}

1. User runs `git commit` in a Dev-card `$` exchange (or a normal terminal). git spawns `core.editor` → `tugedit --wait <repo>/.git/COMMIT_EDITMSG` and blocks.
2. `tugedit` resolves the tugcast port (Spec S05 — inside `$` it reads the injected `TUG_TUGCAST_PORT`), reads the injected `TUG_SESSION_ID` when present (it exists only inside a `$` exchange — Step 2 injects it), generates a `requestId`, and `POST`s `/api/edit {path, wait:true, requestId, tug_session_id?}` with **no read timeout**.
3. tugcast's `/api/edit` handler: rejects non-loopback; if CONTROL has 0 receivers → error (R01); else registers `pending_edits[requestId]`, broadcasts a CONTROL `open-file` frame carrying `wait:true`, `requestId`, `tug_session_id`, and awaits the oneshot.
4. The deck's `open-file` handler opens a dedicated Text card on `path` seeded with the `requestId`. Rung 2: if `tug_session_id` is present, the shell store marks that session's in-flight exchange **parked** ("editing in Tug…").
5. User edits and closes the card. The card's wait-mode close path **awaits `store.flush()`**, then `POST`s `/api/tell {action:"edit-done", requestId}`; rung 2 clears the parked flag.
6. `dispatch_action`'s `edit-done` arm resolves `pending_edits[requestId]`; `/api/edit` returns 200; `tugedit` exits 0.
7. git reads the now-flushed `COMMIT_EDITMSG` and creates the commit. Because rung 1 removed the wall-clock cap, the `$`-route exchange that ran `git commit` was never reaped while blocked.

#### bbedit CLI surface → what `tugedit` adopts, adapts, drops {#bbedit-surface}

**Table T01: bbedit flag → tugedit disposition** {#t01-bbedit-map}

| bbedit | Meaning | tugedit v1 |
|--------|---------|-----------|
| `+<line>[:offset]` | Jump to line/column | **Adopt** `+<line>[:<col>]` (also `path:line[:col]`); maps to `open-file`'s `line`/`endLine`. |
| `-w, --wait` | Block until closed | **Adopt** (the git-critical flag). |
| `-c, --create` | Create if missing | **Defer.** `fs_write` only creates missing files under Tug-owned roots (drafts / asides — `fs_write.rs`); arbitrary creation would fail at save time. v1 errors on a missing path; git's file always exists. |
| `-l, --launch` | Just launch the app | **Adapt** → `tugedit doctor` (connectivity check). |
| `-b, --background` / `-F, --front-window` / `-N, --new-window` / `-S, --separate-windows` | Window placement | **Drop v1**; deck `openTarget` default governs placement. |
| `-s, --worksheet` / `--scratchpad` / `--preview` / `--project` | BBEdit-specific surfaces | **Drop.** |
| `-t, --pipe-title` / stdin piping | New doc from stdin | **Defer** ([Q02]). |
| `--maketags` | ctags | **Drop** (explicitly excluded by the ask). |
| `-v/-V/--version`, `-h/--help` | Version / help | **Adopt** (clap default). |

---

### Specification {#specification}

**Spec S01: `POST /api/edit`** {#s01-api-edit}

Loopback-only (reject non-loopback with 403, like `tell_handler`). Request body:

```json
{ "path": "<absolute or ~ path>", "wait": true, "line": 12, "tug_session_id": "…", "requestId": "<uuid>" }
```

- `path` (required), `requestId` (required), `wait` (default `true`), `line`/`endLine` (optional), `tug_session_id` (optional; present when invoked inside a `$` exchange).
- Handler: if `wait` and the CONTROL broadcast `receiver_count() == 0` → `409` `{status:"error", message:"no Tug window connected"}`. Else broadcast a CONTROL `open-file` frame (Spec S04); if `wait`, register `pending_edits[requestId]` (a `tokio::sync::oneshot::Sender`; same map shape as `PendingEvals`, `router.rs`) and await it under a generous absolute backstop timeout, returning `200 {status:"ok", closed:true}` on resolution or `504` on backstop elapse — **removing the `pending_edits` entry on elapse**, exactly as `eval_handler` cleans up `pending_evals` on its timeout; if not `wait`, return `200` immediately.

**Spec S02: `edit-done` resolution action** {#s02-edit-done}

`dispatch_action` gains an arm mirroring `eval-response`:

```json
{ "action": "edit-done", "requestId": "<uuid>" }
```

Removes and fires `pending_edits[requestId]`. Unknown ids are ignored (idempotent). Requires threading a `pending_edits` map into `dispatch_action` alongside `pending_evals`.

**Spec S03: `tugedit` CLI surface** {#s03-cli}

```
tugedit [OPTIONS] [+<line>[:<col>]] <file>
tugedit install-git [--dry-run]
tugedit uninstall-git
tugedit doctor
```

- Open args: `<file>` (required in v1; **must exist** — `tugedit` stats the path and exits non-zero on a missing file, because `fs_write` won't create files outside Tug-owned roots — see #non-goals), optional leading `+<line>[:<col>]`, and `path:line[:col]` convenience parsed off the positional. Flags: `-w/--wait`, `--port <P>`, `--instance <id>`.
- Exit codes: `0` success (in `--wait`, after the card closed); non-zero on unreachable tugcast, no connected deck, or a bad path. `git` treats non-zero as "editor failed" and aborts the commit.
- `--wait` uses a client with **no read timeout**.
- `install-git`: `git config --global core.editor "<current_exe> --wait"`. `uninstall-git`: unset it (or restore a saved prior value if we recorded one). `doctor`: resolve the port, `GET /api/host`, and report reachability + connected-deck status.

**Spec S04: `open-file` CONTROL frame extension** {#s04-open-file-frame}

The existing `open-file` action (`action-dispatch.ts`) gains optional fields, all backward-compatible (absent = today's behavior):

```json
{ "action": "open-file", "path": "…", "line": 12, "wait": true, "requestId": "<uuid>", "tug_session_id": "…" }
```

When `wait` + `requestId` are present, the deck opens a **dedicated** Text card (bypassing the reuse/newTab open targets) seeded with the `requestId` so its close reports `edit-done`. The `requestId` rides the **open seed only** — it must never be written to the card's persistence bag (mirror `revealOnOpen`'s treatment in `text-card.tsx`: "Never written by the persistence save path — only the open seed carries it"), so a card restored after an app reload can never re-fire `edit-done` for a dead request. If the path is already open in a Text card, the deck activates that card and attaches the handoff to it instead of spawning a duplicate (see Step 5).

**Spec S05: `tugedit` port resolution order** {#s05-port-resolution}

1. `--port <P>` (explicit).
2. `--instance <id>` → `tugcore::registry::find_by_id`.
3. `TUG_TUGCAST_PORT` env (injected into the `$` shell child by Step 2).
4. `TUG_INSTANCE_ID` env → `find_by_id`; else cwd → `find_for_cwd`; else sole live instance (`list_live`).
5. Otherwise error: "no Tug instance found; start one or pass --port/--instance" (multi-instance lists the ids).

#### State Zone Mapping (deck work) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Wait-mode `requestId` seeded into the Text card | local-data | card open seed → `useRef` in `TextCardContent` | [L07] |
| Flush-then-report on wait-mode close | structure/lifecycle | `useLayoutEffect` close hook awaiting `store.flush()` then `fetch("/api/tell")` | [L03], [L27] |
| `parked` flag on the in-flight shell exchange (rung 2) | external data | `shell-session-store` + `useSyncExternalStore` | [L02] |
| "editing in Tug…" row label | appearance derived from store | rendered from the store snapshot (content, not CSS toggle) | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New crates {#new-crates}

| Crate | Purpose |
|-------|---------|
| `tugrust/crates/tugedit` | The `tugedit` CLI binary. |

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugedit/Cargo.toml` | Crate manifest (`clap`, `ureq`, `serde_json`, `uuid`, `tugcore`). |
| `tugrust/crates/tugedit/src/main.rs` | CLI entry + arg parsing. |
| `tugrust/crates/tugedit/src/edit.rs` | Port resolution (Spec S05) + `/api/edit` client (Spec S01). |
| `tugrust/crates/tugedit/src/gitwire.rs` | `install-git` / `uninstall-git` / `doctor`. |
| `tugdeck/src/lib/edit-handoff-store.ts` | (rung 2) parked-exchange bookkeeping keyed by `tug_session_id` (or fold into `shell-session-store.ts`). |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `EXEC_TIMEOUT` | const (remove) | `tugrust/crates/tugcast/src/feeds/shell.rs` | Delete; convert plumbing to `idle_timeout: Option<Duration>`. |
| `run_dispatcher` / `shell_session_task` / `run_command` | fn (modify) | `feeds/shell.rs` | Idle-timeout semantics ([P02]). |
| `shell_dispatcher_task` | fn (modify) | `feeds/shell.rs` | New `tugcast_port: u16` param; production passes `idle_timeout=None`. |
| `spawn_shell_child` | fn (modify) | `feeds/shell.rs` | `.env("TUG_TUGCAST_PORT", port)` + `.env("TUG_SESSION_ID", tug_session_id)` on the child (session id threaded from `shell_session_task`, which already owns it). |
| `pending_edits` | field | `tugrust/crates/tugcast/src/router.rs` (`FeedRouter`) | Mirror of `pending_evals`. |
| `edit_handler` | fn (add) | `tugrust/crates/tugcast/src/server.rs` | `POST /api/edit` (Spec S01); route in `build_app`. |
| `"edit-done"` arm | match arm (add) | `tugrust/crates/tugcast/src/actions.rs` | Resolve `pending_edits` (Spec S02). |
| `open-file` handler | modify | `tugdeck/src/action-dispatch.ts` | Honor `wait`/`requestId`/`tug_session_id` (Spec S04). |
| `openFileInCard` | modify | `tugdeck/src/lib/open-file-in-card.ts` | Wait-mode: dedicated card + seed `requestId`. |
| `TextCardContent` | modify | `tugdeck/src/components/tugways/cards/text-card.tsx` | Wait-mode close: flush → `edit-done` (requestId in a ref, seed-only, never bagged). |
| `TextCardOpenEntry.attachEditHandoff` | method (add) | `tugdeck/src/lib/text-card-open-registry.ts` | Wait-mode open onto an already-open path attaches the pending `requestId` to the existing card. |
| Justfile bin list | modify | `Justfile` (bin loop ~line 15; release inputs ~line 293) | Add `tugedit`. |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | shell dispatcher idle-timeout semantics; `tugedit` arg parsing + port resolution; `edit-done` resolution | Steps 1, 3, 4 |
| **Integration (Rust)** | `/api/edit` request/response over a bound loopback listener with a stubbed CONTROL subscriber | Step 3 |
| **App-test** | drive the real Tug.app: `tugedit --wait` opens a card, close it, observe exit + parked-state | Steps 5, 6, 8 |
| **Manual/Integration** | `git commit` end-to-end in the `$` route | Step 8 |

#### What stays out of tests {#test-non-goals}

- No jsdom/mock-store render tests for the deck (banned pattern) — the parked-state and close-report behavior are exercised via app-test against the real app.
- No test asserting a specific *production* reap time — production has no automatic reap; only the injectable idle path is unit-tested.
- The Text card editor/save internals are pre-existing and covered by their own app-tests (`at0209`, `at0212`); this plan does not re-test them.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. `cd tugrust && cargo nextest run` for Rust; `bunx vite build` before declaring any tugdeck change done; `just app-test` for app-tests.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Rung 1 — remove the wall-clock exec reap | pending | — |
| #step-2 | Inject port + session id into the `$` shell child | pending | — |
| #step-3 | tugcast `/api/edit` + `edit-done` + open-file frame | pending | — |
| #step-4 | `tugedit` crate — CLI + HTTP client + git wiring | pending | — |
| #step-5 | Deck — wait-mode open-file (flush → edit-done) | pending | — |
| #step-6 | Rung 2 — deck parked-exchange state | pending | — |
| #step-7 | git integration + bundle/build wiring | pending | — |
| #step-8 | Integration checkpoint — end-to-end git commit | pending | — |

---

#### Step 1: Rung 1 — remove the wall-clock exec reap {#step-1}

**Commit:** `feat(tugcast): drop the shell $-route wall-clock timeout; idle reap is test-only`

**References:** [P02] Rung 1 timeout ([#p02-rung1-timeout]), [Q01] ([#q01-idle-backstop]), (#context, #strategy)

**Artifacts:**
- `feeds/shell.rs`: `EXEC_TIMEOUT` removed; dispatcher/session/run_command take `idle_timeout: Option<Duration>`; production passes `None`.

**Tasks:**
- [ ] Delete `const EXEC_TIMEOUT`. Change `run_dispatcher`, `shell_session_task`, and `run_command` to thread `idle_timeout: Option<Duration>`.
- [ ] In `run_command`, when `idle_timeout` is `Some(d)`, wrap each `child.lines.next_line()` await in `tokio::time::timeout(d, …)`; on elapse, return `ExecResult { exit_code: None, … }` (reaped) and reap the group. When `None`, await the line with no timeout (unbounded — the sentinel or a `kill` ends it).
- [ ] `shell_dispatcher_task` passes `idle_timeout = None` (production); keep the injectable value for `run_dispatcher` used by tests.
- [ ] Reframe `interactive_tui_is_reaped_by_the_timeout` → an idle-based reap (tests pass `Some(short)`); keep `kill_reaps_a_long_runner` (production path, `None`) intact. Confirm `drive()` still reaps `vim` via the idle path.

**Tests:**
- [ ] `exec_round_trip_and_exit_code`, `cwd_persists_across_commands`, `stdin_reading_command_does_not_desync` unchanged and green.
- [ ] Reframed idle-reap test: a `vim` exchange settles null under a short idle timeout; a follow-up command proves recovery.
- [ ] New: under a short **idle** timeout (e.g. 300ms), a command whose **total runtime exceeds the window** but which emits output more often than the window (a loop printing every ~100ms for ~1s) completes with a real exit code — directly proves the reap is idle-based, not wall-clock. Plus: assert the production `shell_dispatcher_task` constructs with `idle_timeout = None`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast feeds::shell`
- [ ] `cd tugrust && cargo build` (warnings are errors)

---

#### Step 2: Inject port + session id into the `$` shell child {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugcast): export TUG_TUGCAST_PORT and TUG_SESSION_ID into the $-route shell environment`

**References:** [P04] Transport ([#p04-transport]), [P06] Parked deck-only ([#p06-parked-deck-only]), Spec S05 ([#s05-port-resolution])

**Artifacts:**
- `feeds/shell.rs`: `spawn_shell_child` sets `TUG_TUGCAST_PORT` and `TUG_SESSION_ID`; port threaded from `main.rs`.

**Tasks:**
- [ ] Add a `tugcast_port: u16` param to `shell_dispatcher_task` and thread it to `spawn_session_shell` → `spawn_shell_child`, which adds `.env("TUG_TUGCAST_PORT", port.to_string())`.
- [ ] Also inject `TUG_SESSION_ID`: `shell_session_task` already owns its `tug_session_id: String` — thread it into `spawn_session_shell` → `spawn_shell_child` and set `.env("TUG_SESSION_ID", &tug_session_id)` on the child. **Nothing sets this env var anywhere today**; it is new, and it is what lets a `tugedit` under a `$` exchange tag its `/api/edit` with the originating session so rung 2 can park the right row.
- [ ] In `main.rs`, pass `actual_port` to the `shell::shell_dispatcher_task(...)` spawn.
- [ ] Confirm no env is cleared on the child (it isn't), so `TUG_INSTANCE_ID` remains visible to descendants for the registry fallback.

**Tests:**
- [ ] Unit: extend a shell dispatcher test to run `printf '%s %s' "$TUG_TUGCAST_PORT" "$TUG_SESSION_ID"` and assert the exchange output carries the port passed in and the exchange's own `tug_session_id`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast feeds::shell`

---

#### Step 3: tugcast `/api/edit` + `edit-done` + open-file frame {#step-3}

**Depends on:** #step-1

**Commit:** `feat(tugcast): add POST /api/edit blocking editor handoff + edit-done resolution`

**References:** [P03] Edit endpoint ([#p03-edit-endpoint]), [P05] Completion ([#p05-completion]), Spec S01 ([#s01-api-edit]), Spec S02 ([#s02-edit-done]), Spec S04 ([#s04-open-file-frame]), Risk R01 ([#r01-no-deck])

**Artifacts:**
- `router.rs`: `pending_edits` map (mirror `pending_evals`). `server.rs`: `edit_handler` + route. `actions.rs`: `edit-done` arm.

**Tasks:**
- [ ] Add `pending_edits: PendingEdits` (alias of the `pending_evals` map type) to `FeedRouter`; construct it where `pending_evals` is constructed.
- [ ] Add `edit_handler` in `server.rs` implementing Spec S01: loopback guard; 0-receiver fast-fail on the CONTROL broadcast (`receiver_count()`); broadcast the `open-file` frame with `wait`/`requestId`/`tug_session_id`/`line`; on `wait`, register the oneshot and `await` under a generous backstop `timeout`, **removing the `pending_edits` entry on backstop elapse** (mirror `eval_handler`'s timeout cleanup). Register `POST /api/edit` in `build_app`.
- [ ] Verify the 0-receiver assumption before relying on it: confirm nothing inside tugcast holds a long-lived CONTROL broadcast **receiver** (sender clones like `LedgerSessionsRecorder::with_broadcast`'s don't count), so `receiver_count() == 0` truly means "no deck connected." If an internal receiver exists, demote the fast-fail to best-effort and let the backstop timeout be the real guard.
- [ ] Add the `"edit-done"` arm to `dispatch_action` (thread `pending_edits` in as a new parameter). There are **three** production call sites to update, not two: `server.rs` `tell_handler`, `control.rs` control-socket recv loop (~`control.rs:120`), and the WS control-frame path in `router.rs` (the arm near `router.pending_evals`); plus the unit-test call in `actions.rs`.

**Tests:**
- [ ] Unit: `dispatch_action("edit-done", …)` fires a registered `pending_edits` oneshot; unknown id is a no-op.
- [ ] Integration: bind a loopback listener via `build_app`, subscribe a fake CONTROL receiver, `POST /api/edit {wait:true}`; assert the `open-file` frame is broadcast with the fields; then `POST /api/tell {edit-done}` and assert `/api/edit` returns 200. Separately assert 0-receiver → error.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo build`

---

#### Step 4: `tugedit` crate — CLI + HTTP client + git wiring {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugedit): new bbedit-style CLI that opens files in Tug (--wait, +line, install-git)`

**References:** [P04] Transport ([#p04-transport]), [P07] git wire ([#p07-git-wire]), Spec S03 ([#s03-cli]), Spec S05 ([#s05-port-resolution]), Table T01 ([#t01-bbedit-map]), Risk R04 ([#r04-instance-ambiguity])

**Artifacts:**
- New crate `tugrust/crates/tugedit` (`main.rs`, `edit.rs`, `gitwire.rs`); added to workspace `members`.

**Tasks:**
- [ ] Scaffold the crate; add to `tugrust/Cargo.toml` `members`. Deps: `clap` (derive), `ureq`, `serde_json`, `uuid`, `tugcore`.
- [ ] Parse the open form (Spec S03): positional `<file>`, optional leading `+<line>[:<col>]`, and `path:line[:col]` convenience; flags `-w/--wait`, `--port`, `--instance`. Stat the path and exit non-zero with a clear message when the file does not exist — no `--create` in v1 (Table T01, #non-goals).
- [ ] Implement port resolution (Spec S05) in `edit.rs` — read `TUG_TUGCAST_PORT`, else `tugcore::registry` (`find_by_id` via `TUG_INSTANCE_ID`, `find_for_cwd`, `list_live`).
- [ ] Implement the `/api/edit` client: canonicalize the path to absolute (git invokes the editor with a relative `.git/COMMIT_EDITMSG` from the repo root — resolve against `tugedit`'s own cwd); generate `requestId`; read `TUG_SESSION_ID` if present (injected by Step 2, `$`-route only); POST with **no read timeout** in `--wait`; map transport failure / non-200 to a non-zero exit with a clear stderr message.
- [ ] Implement `install-git` (`git config --global core.editor "<current_exe> --wait"`, `--dry-run` prints the command), `uninstall-git`, and `doctor` (resolve port, `GET /api/host`, report reachability). Note: `TUG_SESSION_ID` is only present inside the `$` route; outside it, the handoff still works (no `tug_session_id`, so no rung-2 parked marker).

**Tests:**
- [ ] Unit: arg parsing (`+42 file`, `file:42:3`, bare `file`); `--wait` flag; resolution precedence (explicit `--port` wins; unknown `--instance` errors) — mirror `tell.rs`'s `resolve_port` tests.
- [ ] Unit: `install-git` `--dry-run` emits the expected `git config` invocation with an absolute path.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugedit`
- [ ] `cd tugrust && cargo build -p tugedit`

---

#### Step 5: Deck — wait-mode open-file (flush → edit-done) {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `feat(tugdeck): honor wait-mode open-file — dedicated card reports edit-done on close`

**References:** [P05] Completion ([#p05-completion]), Spec S04 ([#s04-open-file-frame]), Risk R02 ([#r02-flush-ordering]), (#state-zone-mapping)

**Artifacts:**
- `action-dispatch.ts` (`open-file` handler), `open-file-in-card.ts`, `text-card.tsx`.

**Tasks:**
- [ ] Extend the `open-file` handler to read `wait`, `requestId`, `tug_session_id` and pass them to `openFileInCard`.
- [ ] In `openFileInCard`, when `wait` + `requestId` are set, **bypass the reuse/newTab open targets** — `addCard("text", seed)` with the `requestId` in the seed — so the handoff owns a dedicated card whose close is unambiguous. Exception: if the path is **already open** in a Text card (`findTextCardByPath`), never spawn a second card onto the same file (the watcher-fight `text-card-open-registry` exists to prevent) — activate the existing card and attach the pending `requestId` to it via a new `attachEditHandoff(requestId)` method on `TextCardOpenEntry`, so *its* close reports `edit-done`.
- [ ] In `TextCardContent`, hold the edit-handoff `requestId` in a **ref seeded from the open payload only** — it must never flow through the `onSave` bag path (mirror `revealOnOpen`'s "never written by the persistence save path" treatment), so a restored card can't re-fire `edit-done` after a reload.
- [ ] Register the close report in a `useLayoutEffect` ([L03]/[L27]) whose **cleanup** (card unmount = real close; background tabs stay mounted per CardHost) runs `void store.flush().then(() => postEditDone(requestId))` — a promise **chain**, not an `await` (effect cleanups are synchronous), posting `fetch("/api/tell", { method: "POST", body: JSON.stringify({ action: "edit-done", requestId }) })` with a relative URL exactly like `file-io.ts`. Guard against double-send. Ordering note: in **manual** save mode the card's close guard (`registerCardCloseGuard`) resolves Save / Don't Save *before* unmount, so the unmount-time flush observes the settled buffer; "Don't Save" leaves the on-disk template unedited and git aborts on the empty message — the same semantics as closing bbedit without saving. A page reload never runs effect cleanups (page teardown, not unmount), so a reload cannot false-fire `edit-done`; the orphaned request falls to the server backstop (Risk R01 residual).

**Tests:**
- [ ] App-test: `POST /api/edit {wait:true}` (or drive `tugedit --wait`) against the running app opens a Text card on a temp file; programmatically close it; assert the file is on disk with edited content and that the `/api/edit` call returned (the CLI process exited 0).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test` (the new wait-mode test)

---

#### Step 6: Rung 2 — deck parked-exchange state {#step-6}

**Depends on:** #step-5

**Commit:** `feat(tugdeck): show "editing in Tug…" on a shell exchange parked on an editor`

**References:** [P06] Parked deck-only ([#p06-parked-deck-only]), Spec S04 ([#s04-open-file-frame]), (#flow-git-commit, #state-zone-mapping)

**Artifacts:**
- `shell-session-store.ts` (a `parked` flag on the in-flight exchange), the shell row renderer.

**Tasks:**
- [ ] On a wait-mode `open-file` carrying `tug_session_id`, mark that session's in-flight shell exchange `parked` in the shell store ([L02]); clear it on `edit-done` (route the clear through the store from the same handler, keyed by `requestId`→`tug_session_id`).
- [ ] Render the parked exchange row with an "editing in Tug…" label in place of the bare running spinner. Appearance derives from the store snapshot — no React appearance state ([L06]).

**Tests:**
- [ ] App-test: drive `tugedit --wait` inside a `$` exchange (or synthesize the wait-mode `open-file` with a `tug_session_id`); assert the exchange row shows the parked label while open and reverts after `edit-done`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test`

---

#### Step 7: git integration + bundle/build wiring {#step-7}

**Depends on:** #step-4

**Commit:** `build(tugedit): ship tugedit in the bundle and wire git via install-git`

**References:** [P07] git wire ([#p07-git-wire]), [Q03] ([#q03-path-install])

**Artifacts:**
- `Justfile` (bin build/symlink loop ~line 15; release bundle inputs ~line 293). Any `tugapp/Sources/ProcessManager.swift` bundled-binary reference if bins are enumerated there.

**Tasks:**
- [ ] Add `tugedit` to the Justfile bin loop (built + symlinked to `~/.local/bin`) and to the release bundle inputs so it lands in `Tug.app/Contents/Resources`.
- [ ] Verify `tugedit install-git` writes `core.editor` to the absolute bundled/symlinked path; document the `GIT_EDITOR`-overrides-`core.editor` caveat in `tugedit --help` / crate docs.

**Tests:**
- [ ] `just build` (or the relevant recipe) produces a `tugedit` binary in `~/.local/bin` and the app bundle.
- [ ] Manual: `tugedit install-git --dry-run` prints the expected config; `git config --global --get core.editor` after `install-git` shows `<abs> --wait`.

**Checkpoint:**
- [ ] `tugedit doctor` against a running instance reports reachable + deck-connected.

---

#### Step 8: Integration checkpoint — end-to-end git commit {#step-8}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #flow-git-commit)

**Tasks:**
- [ ] With `core.editor` pointed at `tugedit --wait`, run `git commit` in a throwaway repo **inside a Dev-card `$` exchange**: confirm a Text card opens on `COMMIT_EDITMSG`, the exchange row shows "editing in Tug…", editing + closing the card creates the commit with the edited message, and the `$` exchange settles with exit 0 (never reaped mid-edit).
- [ ] Repeat from a **normal terminal** (no `TUG_SESSION_ID`): confirm the handoff still works (no parked marker; that's expected).
- [ ] Negative: stop Tug; `git commit` → `tugedit` exits non-zero within ~1s and the commit aborts cleanly.

**Tests:**
- [ ] The Step 5 and Step 6 app-tests both green.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run && cd ../tugdeck && bunx vite build && cd .. && just app-test`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** `tugedit`, a Rust CLI that opens files in a running Tug.app with bbedit-style line addressing and a blocking `--wait`, wired so `git commit` edits its message in Tug — built on a shell that no longer reaps active commands at an arbitrary 120s (rung 1) and shows a parked-on-editor exchange state (rung 2).

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] The `$` route no longer reaps a long, active command at 120s (Step 1 tests; Step 8 long-runner).
- [ ] `tugedit --wait <file>` opens the file in Tug and blocks until the card closes, then exits 0 (Step 5 app-test).
- [ ] `git commit` edits `COMMIT_EDITMSG` in Tug and creates the commit (Step 8).
- [ ] No running Tug → `tugedit` exits non-zero fast; `git commit` aborts (Step 8 negative).
- [ ] A `$`-route commit shows "editing in Tug…" while parked (Step 6 app-test).
- [ ] `cargo nextest run` and `bunx vite build` and `just app-test` all green with zero warnings.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] stdin piping (`git diff | tugedit`) + `--pipe-title` ([Q02]).
- [ ] `--create` — requires an `fs_write` posture change to create missing files outside the Tug-owned drafts/asides roots (see #non-goals).
- [ ] A production idle-output backstop, if wedged-session reports appear ([Q01]).
- [ ] Rung 3: an opt-in PTY-backed interactive session channel (password prompts, REPLs, `git rebase -i`).
- [ ] Window-placement flags (`--new-window`, `--background`) and a `/usr/local/bin` installer.

| Checkpoint | Verification |
|------------|--------------|
| Rung 1 | `cargo nextest run -p tugcast feeds::shell` (idle-reap + no-cap tests) |
| Handoff transport | `cargo nextest run -p tugcast` (`/api/edit` integration) |
| CLI | `cargo nextest run -p tugedit` |
| End-to-end | `just app-test` + manual `git commit` in the `$` route |
