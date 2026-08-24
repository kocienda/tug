## Fix the `/compact` Flow: Detection, Deadlock, and Live/Reload Consistency {#compact-issues}

**Purpose:** Make the Dev card's `/compact` behave like the Claude Code TUI's: it is recognized even when the argument carries `@`/file mentions, it runs to completion behind the progress sheet, then shows a **visible carry-forward summary** and lands the fresh session **idle with the composer enabled** (compact-then-wait) — no invisible auto-turn, and live matches reload.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-19 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Claude Code exposes no native compaction over the stream-json bridge, so tugdeck reconstructs `/compact` itself: it runs a *suppressed* summarization turn on the current session, captures the assistant prose as a summary, spawns a **fresh** session, closes the old one, and then — when the fresh session binds — delivers the summary as **another suppressed turn** before settling the progress sheet (`compaction-request.ts`, `pending-compaction-store.ts`, `dev-session-restore.ts`, `dev-card.tsx`). Three defects fall out of this design, all reproduced in this session:

1. **`/compact <message-with-a-file-mention>` is never recognized.** Client-side slash-command detection only builds a command line for a pure-text draft or a lone command atom (`tug-prompt-entry.tsx`, `#detection-gap`). Any embedded `@`/file-mention atom defeats detection, so the whole line is sent to Claude as ordinary text — no sheet, no compaction.

2. **The seed turn deadlocks the card.** `suppress` is a *client-side reducer marker only* (it never crosses the wire — `reducer.ts` `handleSend`, `#suppress-is-client-only`). tugcode therefore forwards the seed to Claude and emits **every** event back, including a `control_request_forward` when Claude calls `AskUserQuestion`. The reducer flips to `awaiting_approval` (composer disabled) but the suppressed turn renders nothing — so there is **no answerable dialog and no way out** (`#deadlock-chain`).

3. **All of that work was invisible until reload.** Because the seed turn ran on the wire but was suppressed from display, the user saw an empty "Session compacted" card while a full Claude turn (including the failed `AskUserQuestion`) was written to JSONL — then surfaced on rejoin. Reload (JSONL) is authoritative, so live and reload disagreed.

The root is structural: **a suppressed turn that nonetheless draws a real, response-producing Claude turn.** The seed prompt is even written to elicit one ("…treat it as established context and continue seamlessly"). Suppression was reuse of the summarization-turn mechanism, not a decided contract — nothing in `tuglaws/` or `message-architecture.md` governs it, so we have design freedom.

#### Strategy {#strategy}

- **Match the TUI (the spine).** Progress sheet runs to completion → a **visible carry-forward summary** is shown in the transcript → the fresh session lands **idle** with the composer enabled, awaiting the user's next message. No standalone seed turn, so no auto-continuation and no invisible turn.
- **Compact-then-wait delivery.** The recap is held as an in-memory *deferred seed* and reaches Claude only by riding (on the wire) on the user's **first real message** — so the first post-compact turn is the user's own visible, interactive turn. The deadlock class is removed by construction.
- **Fix detection independently first.** The `/compact`-through-mentions bug is self-contained and shippable on its own; do it first so the command is reliably recognized before we change what it does.
- **Show the summary, consistently, via a marker.** The deferred recap is wrapped in a recognizable sentinel; the carry-forward summary renders from `compactionSeed` state on the live path and from the reload reconstruction afterward — the same visible block either way, so live == reload.
- **No new persistence.** The deferred seed lives only in memory; a hard reload before the first message simply yields a fresh session (the pre-compaction session is closed-but-resumable). We deliberately do **not** stash the recap in tugbank — it is a transient, not a preference (see [Q02]).
- Every step is a real code path verified against a real session (no mock-store / fake-DOM tests, per project policy); the phase closes on a real-app `/compact` drive.

#### Success Criteria (Measurable) {#success-criteria}

- Typing `/compact prepare to implement @dash/message-architecture.md` opens the compaction progress sheet (not sent to Claude as text). Verified by app-test: the sheet mounts and no `user_message` with that literal text is committed. (#detection-gap)
- The focus argument passed to summarization contains the resolved file path (e.g. `Give particular attention to: dash/message-architecture.md`). Verified by unit test on the command-line builder + `buildSummarizationPrompt`. (#focus-expansion)
- After a `/compact` completes, a **visible carry-forward summary** is shown, the fresh session's STATE is `Idle`, and the composer is **enabled** (`canSubmit === true`) with no assistant turn rendered. Verified by app-test reading `codeSessionStore` phase + transcript. (#compact-then-wait)
- A `/compact` flow never enters `awaiting_approval` without a visible, answerable dialog. Verified by app-test: drive `/compact`, assert phase reaches `idle` (never stuck `awaiting_approval`). (#deadlock-chain)
- The carry-forward summary renders identically **live and after reload (once the first message has been sent)**, and the user's first message renders as its own row below the summary (the recap is not duplicated into the user bubble). Verified by app-test: compact, send a message, snapshot the summary; reload; snapshot again; assert the summary block is equal. (#live-reload-consistency)

#### Scope {#scope}

1. Recognize `/compact` (and all local commands) regardless of embedded atoms; expand file/doc mention atoms in the focus argument to their paths.
2. Replace the auto-response seed with a **deferred seed** held in `compactionSeed` state: bind → idle + visible carry-forward summary + `seedPending`; first user `send()` → recap rides as a marked leading content block on the wire.
3. Marker-based rendering so the recap renders as the carry-forward summary on both the live path and the reload reconstruction.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Re-architecting compaction to avoid spawning a fresh session (the spawn-new + summary-seed approach is spike-verified; keep it).
- Auto-continuation after compaction (the user chose compact-then-wait; an assistant that resumes work on its own is explicitly not wanted here).
- Persisting the deferred seed across a hard reload (accepted as ephemeral — see [Q02]); no tugbank/`localStorage` involvement.
- Handling Claude's native *auto*-compaction (`compact_boundary` from tugcode) — that path is separate and not implicated in these defects.
- Editing the captured summary before it is used, or a multi-turn summarization.
- A general fix for *all* slash commands that should take rich arguments — only `/compact`'s focus needs mention expansion here (other commands already match as pure text or lone atoms).
- Hardening permission-response routing across a session swap (was a candidate step; deferred to a follow-on pending a reproduction — see [Q03]).

#### Dependencies / Prerequisites {#dependencies}

- Existing compaction plumbing: `compaction-request.ts`, `pending-compaction-store.ts`, `compaction-progress-store.ts`, `dev-session-restore.ts` (`deliverPendingCompactionSeeds`), and the `/compact` handler in `dev-card.tsx`.
- The replay reconstruction seam in the store wrapper (`code-session-store.ts`, the `add_user_message` replay dispatch over raw `content` blocks) and `synthesizeUserMessageFromBlocks`.
- Atom/mention helpers: `atom-mention-marker.ts` (`parseAtomMentionSegments`), `build-wire-payload.ts`, `synthesize-user-message.ts`.

#### Constraints {#constraints}

- Tugways laws apply: external state enters React via `useSyncExternalStore` only ([L02]); appearance via CSS/DOM, not React state ([L06]). Cross-check `tuglaws.md` / `pane-model.md` / `component-authoring.md` and name the laws touched in each commit.
- No `localStorage`/`sessionStorage`/IndexedDB (and, by this plan's choice, no tugbank either for the transient seed).
- Warnings are errors (`-D warnings`); `bun` (never `npm`); tugdeck HMR is live (no manual build); tugcode is a compiled binary that must be rebuilt if touched.
- Anything placed on the wire to Claude lands in JSONL and is reconstructed on reload — a "hidden" payload renders consistently only if the reconstruction path also recognizes it and renders the same block. This is the governing reality behind [P03] and [P04].

#### Assumptions {#assumptions}

- The suppressed **summarization** turn (on the discarded old session) does not require an interactive tool — the prompt is pure-text recap. A guard ([P05]) covers the rare exception rather than assuming it can't happen.
- tugcode forwards `control_request_forward` for any turn regardless of the client's `suppress` marker (verified: suppress never crosses the wire — `#suppress-is-client-only`).
- A fresh `/compact`-born session given only the recap on its first user message recalls prior facts well enough to continue (spike-verified for the standalone-seed form; the deferred-prefix form delivers the same bytes to Claude, just attached to the first real message).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; steps cite plan artifacts and anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Recap on the wire reappears as raw text on reload (DECIDED) {#q01-reload-raw-text}

**Question:** If the recap rides on the user's first message, the wire content (recap + text) lands in JSONL, and reload reconstructs the user bubble from JSONL — showing the recap as raw text. How do we keep live == reload?

**Why it matters:** Without a fix, we trade the old "hidden turn surfaces on reload" bug for a new "hidden prefix surfaces on reload" bug — the same (C)-class inconsistency.

**Options (if known):**
- Wrap the recap in a sentinel marker; both the live path and the reload reconstruction recognize it and render the same carry-forward summary block. (chosen)
- Accept the inconsistency (recap visible only on reload). (rejected — re-introduces the user's complaint)

**Plan to resolve:** Designed in [P04]; implemented in #step-4 with a shared `splitCompactionSeed` helper used at the wire-injection seam and the replay-reconstruction seam.

**Resolution:** DECIDED — see [P04].

#### [Q02] Deferred seed lost on a hard reload before the first message (DEFERRED) {#q02-seed-loss}

**Question:** The deferred seed lives only in memory until the first `send()`. A hard reload before then (which re-resumes from JSONL) drops the summary — the fresh session has no committed turns.

**Why it matters:** Earlier framed as "silent loss of the compaction work." On inspection the cost is low: the **pre-compaction session is closed-but-resumable on disk** with full context, so nothing is truly lost — at worst the user re-runs `/compact`. The window (compaction done → first message) is small.

**Options considered:**
- Persist the seed in tugbank `defaults`, restore at bind. (rejected — `defaults` is a preferences store; a multi-KB transient recap blob does not belong there, and the case it guards is narrow with a natural fallback.)
- Accept the seed as ephemeral; rely on the resumable old session. (chosen)

**Resolution:** DEFERRED — accepted ephemeral. No persistence is built. If real usage shows the reload-before-first-message window bites often, revisit with a purpose-built mechanism (not `defaults`).

#### [Q03] Harden approval-response routing across a session swap? (DEFERRED) {#q03-approval-race-scope}

**Question:** A pending approval might misroute its response when the card's binding swaps to a new session. Include a guard here?

**Why it matters:** It was a candidate fix because the deadlock surfaced near a session swap.

**Analysis:** On any `tugSessionId` change, `card-services-store._reconcile` **disposes** the old `CodeSessionStore` and constructs a fresh one (`_dispose` → `_construct`). A pending dialog is bound to the disposed store and is torn down with it — there is no live surface from which a response could be sent under a *new* session id, so the misroute is not reachable on the swap path. Separately, compact-then-wait ([P03]) removes the `/compact`-specific trigger entirely (the real incident was the *new* store's suppressed turn). Building a guard for an unreachable path is waste.

**Resolution:** DEFERRED to a follow-on. If a concrete reproduction of a misrouted (or orphaned) approval is found, scope it then — and target the real residual (a pending dialog should be cleanly dismissed when its store is disposed mid-flight), not a session-id stamp on a store that doesn't survive the swap. (#roadmap)

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Reload reconstruction renders the summary differently from live | med | med | One sentinel, one `splitCompactionSeed` helper used at both seams; app-test snapshots live + reload and asserts equality (#step-4) | Reload snapshot ≠ live snapshot |
| Suppressed summarization turn needs a tool/approval and deadlocks | med | low | Watcher treats an `awaiting_approval` transition *while the summarization turn is still active* as failure: interrupt + fail, session intact (#step-2, [P05]) | Any deadlock observed during the summarization half |
| Recap prose mangled by passing through `synthesizeUserMessageFromBlocks` (it parses `@`-mentions/backticks) | med | low | Split the sentinel on **raw `content` blocks** at the wrapper seam, before synthesis (#step-4, [P04]) | Reconstructed summary differs from the sent recap |
| Hard reload before first message loses the seed | low | low | Accepted ([Q02]); old session resumable | Window observed to bite users often |
| Deferred seed never flushed (user only runs slash commands, never sends a message) | low | low | Seed is single-use and in-memory; `/clear`/re-compact spawns a new session and abandons it; documented edge | Stale seed flushed into an unrelated later message |

**Risk R01: Live/reload divergence persists** {#r01-reload-divergence}
- **Risk:** The recap renders differently live vs. on reload-after-send.
- **Mitigation:** One marker convention, one `splitCompactionSeed` helper, consumed at the wire-injection seam (live) and the replay-reconstruction seam (reload); an app-test snapshots both and asserts equality.
- **Residual risk:** A future change to the reconstruction path could bypass the helper — covered by the equality test as a drift guard.

**Risk R02: Summarization-half deadlock** {#r02-summarization-deadlock}
- **Risk:** The (still-suppressed) summarization turn enters `awaiting_approval` and deadlocks exactly like the old seed.
- **Mitigation:** [P05] — the `/compact` watcher fails the run on an `awaiting_approval` transition *during the active summarization turn*; the session is left intact and the composer re-enables.
- **Residual risk:** A summarization that legitimately needs a tool simply can't compact; acceptable (rare; user re-issues).

---

### Design Decisions {#design-decisions}

#### [P01] `/compact` is recognized regardless of embedded atoms (DECIDED) {#p01-detection-through-atoms}

**Decision:** Slash-command detection in `performSubmit` builds a command line whenever the draft's **leading** token is a slash command — whether typed as text (`/compact …`) or a lone command atom — even if the remainder contains `@`/file mentions or other atoms.

**Rationale:**
- Today `commandLine` is `null` for any draft that isn't pure text or a single command atom (`#detection-gap`), so `/compact @file` silently reaches Claude as text.
- A focus argument with file mentions is a natural, expected input.

**Implications:**
- A small pure helper reconstructs `{ name, focusText }` from `(text, atoms)`; `matchLocalSlashCommand` then matches the rebuilt string.
- Only affects commands whose spec `takesArgs` — bare commands keep their existing lone-atom path.

#### [P02] File/doc mentions in the focus expand to their paths (DECIDED) {#p02-focus-expansion}

**Decision:** When building the focus text for `/compact`, each file/doc/url mention atom contributes its `.value` (the path/reference); plain text passes through. The resolved focus flows into `buildSummarizationPrompt`.

**Rationale:**
- The summarizer benefits from knowing *which* file you care about; a bare display label loses that.
- Matches the user's chosen behavior ("expand to file paths").

**Implications:**
- The command-line builder walks `(text, atoms)` in order, substituting atom `.value` for atom positions.
- Image atoms are not meaningful focus; they are dropped from the focus string (documented).

#### [P03] Compact-then-wait: visible summary, no auto-response seed turn (DECIDED) {#p03-compact-then-wait}

**Decision:** The fresh session is **not** sent a standalone seed turn. On bind it lands `idle` with the composer enabled, a **visible carry-forward summary** shown in the transcript, and the recap held as an in-memory *deferred seed*. The recap reaches Claude only by riding (on the wire) on the user's **first real `send()`**.

**Rationale:**
- A user message on stream-json always draws a response; a standalone seed turn therefore always produces a turn. Suppressing that turn hides exactly the surface (dialog, streaming) needed to interact with it → the observed deadlock (`#deadlock-chain`).
- Riding the recap on the first real message makes the first post-compact turn the user's own visible, interactive turn — the deadlock class cannot occur.
- The user wants the Claude Code TUI behavior: run, show a carry-forward summary, then idle and ready — no auto-continuation.

**Implications:**
- `deliverPendingCompactionSeeds` consumes `pendingCompactionStore` **once** at bind (`take`), then calls `markCompactionSeed(summary, preTokens)` — there is no second read of `pendingCompactionStore` afterward.
- `compactionSeed` state becomes the **single source of truth** for the deferred seed: `{ preTokens, summary, seedPending }` (see [P06]). It carries the **summary text** (so the carry-forward block renders before any message is sent) and the `seedPending` flag that `send()` reads and clears.
- `pendingCompactionStore` keeps its original, sole role — the old→new session hand-off, consumed once at bind. It does **not** track "pending until first send."
- `send()` gains a deferred-seed flush off `compactionSeed.seedPending` (see [P04]).
- The `suppress` flag is no longer used for the seed. (The summarization half still uses it; see [P05].)

#### [P04] Deferred recap rides the first message under a sentinel; rendered as a visible carry-forward block on both paths (DECIDED) {#p04-seed-marker}

**Decision:** On the first `send()` after compaction (gated on `compactionSeed.seedPending`, see [P06]), `send()` prepends the recap as a **separate leading content block** to the **wire `content` array** — `content[0]` is the seed block, the user's typed message follows. The **user-bubble display substrate** carries only the user's typed text. The seed block is marked with an **innocuous comment sentinel** (`<!-- tug:compact-seed -->`) on its first line so detection is exact *and* the marker is invisible to Claude (it reads the marker as a comment, then the natural `buildCompactionSeed` framing). A shared `splitCompactionSeed(content)` helper recognizes the seed block and is applied at **two seams**, both operating on **raw `content` blocks** (never on post-synthesis text):

- **Live (wire-injection seam, `code-session-store.send`):** the carry-forward summary already renders from `compactionSeed` state ([P03]); `send()` prepends the seed block to `wire.content` and the user-bubble substrate stays the typed text.
- **Reload (replay-reconstruction seam, the `add_user_message` dispatch in the store wrapper):** the helper splits the seed block off the raw `ev.content` **before** `synthesizeUserMessageFromBlocks`, dispatches `mark_compaction_seed` (with the summary text) to re-create the carry-forward block, and synthesizes only the residual user content into the bubble.

This gives **two sources for the same visible block, covering disjoint cases**: `compactionSeed` state on every live render (pre- and post-send); the seed-block reconstruction on reload-after-send. They feed the *same* `compactionSeed` rendering surface, so they render identically by construction (R01).

**Rationale:**
- Anything on the wire lands in JSONL; reload reconstructs from JSONL. The carry-forward block stays consistent only if the reconstruction recognizes the seed block and re-marks the same `compactionSeed` (#constraints).
- A **separate leading content block** + a **comment-style marker** keeps Claude's prompt clean: it sees a comment line then the existing natural framing, not raw `<<<…>>>` noise inline with the user's text.
- Splitting on **raw `content` blocks** (not synthesized text) avoids `synthesizeUserMessageFromBlocks` mangling recap prose that contains `@` or backticks, and makes detection structural (is `content[0]` the marked seed block?) rather than a fragile natural-language prefix match.
- One marker + one helper + one rendering surface guarantees the summary renders identically live and on reload (resolves [Q01]).
- The summary must be *visible* (TUI parity), so the helper drives the carry-forward block rather than hiding the text.

**Implications:**
- The comment-sentinel constant lives beside `buildCompactionSeed`; `buildCompactionSeed` emits the marked seed block (marker line + framing + summary).
- `splitCompactionSeed(content)` returns `{ seedSummary, residualContent } | null` by inspecting whether `content[0]` is a text block beginning with the marker.
- The "seed pending until first send" condition lives in `compactionSeed.seedPending` ([P06]); `send()` clears it on flush so the recap is never prepended onto the *second* message.
- The reconstruction reuses the existing `compactionSeed` top-of-transcript rendering, now carrying the summary text; the residual typed text renders as the user bubble below it.

#### [P05] The summarization half fails safe instead of deadlocking (DECIDED) {#p05-summarization-failsafe}

**Decision:** The `/compact` turn-watcher treats an `awaiting_approval` transition **while the suppressed summarization turn is still active** as a failure: it interrupts the turn and calls `compactionProgressStore.fail(...)`, leaving the session intact and the composer re-enabled.

**Rationale:**
- The summarization turn is still suppressed (it runs on the discarded old session). If it ever drew an approval it would deadlock identically to the old seed (R02). Failing safe keeps the card usable.

**Implications:**
- The existing watcher acts at the active-turn → `null` transition (end of turn); it must gain an **active-phase** check (`activeTurn !== null && phase === "awaiting_approval"`) so it can bail *before* the turn would otherwise hang, not only at a clean end.
- The watcher needs a **settled-guard** mirroring the existing `canceled` flag: cancelling on `awaiting_approval` calls `interrupt()`, which then drives `activeTurn → null` and would otherwise also trip the end-of-turn branch. A `failed` (run-settled) flag ensures the run resolves exactly once.

#### [P06] `compactionSeed` is the single source of truth for the deferred seed (DECIDED) {#p06-seed-ownership}

**Decision:** The deferred seed's "pending until first send" state lives in **`compactionSeed`**, whose shape grows to `{ preTokens: number | null, summary: string | null, seedPending: boolean }`. `pendingCompactionStore` keeps only its original old→new session hand-off role (consumed once at bind via `take`).

**Rationale:**
- Two stores both tracking the pending seed would diverge. One owner removes the ambiguity, and `compactionSeed` already lives on the session store that `send()` and the transcript both read — so the summary, the carry-forward display, and the flush gate all read the same state.
- Avoids needing a non-consuming `peek` on `pendingCompactionStore` (it has only `set`/`take`/`clear`).

**Implications:**
- `markCompactionSeed(summary, preTokens)` sets `compactionSeed = { preTokens, summary, seedPending: true }`; the `mark_compaction_seed` event + reducer handler carry the summary text.
- `send()` reads `compactionSeed?.seedPending` to decide whether to prepend the seed block, and dispatches an action that flips `seedPending → false` on flush (the summary text stays for the carry-forward rendering).
- On reload-after-send, the reconstruction re-dispatches `mark_compaction_seed` with `seedPending: false` (the seed already rode the JSONL'd first message; it must not be re-prepended).

---

### Deep Dives {#deep-dives}

#### Detection gap (current behavior) {#detection-gap}

`performSubmit` (`tug-prompt-entry.tsx`) only assigns `commandLine` when `draftAtoms.length === 0` (pure text) or a single lone command atom; any other atom mix leaves `commandLine = null`, so `matchLocalSlashCommand` is never called and the draft flows to `send()`. `/compact <focus with @file>` therefore reaches Claude as plain text — no sheet, no compaction. [P01] closes this.

#### `suppress` is client-only {#suppress-is-client-only}

`CodeSessionStore.send(..., { suppress })` dispatches a `send` event carrying `suppress`; the reducer stores it on `pendingTurn.suppressed` and drops the transcript append at `turn_complete`, but the **wire** frame is `{ type: "user_message", content }` with no suppress bit (`reducer.ts` `handleSend`). tugcode never learns the turn is "suppressed" and forwards all events, including `control_request_forward`. This is why a suppressed turn can still drive `awaiting_approval`.

#### Deadlock chain (observed) {#deadlock-chain}

1. Summarization turn (old session, suppressed) → summary captured.
2. Spawn new session; close old.
3. New session binds → seed sent suppressed (today).
4. tugcode forwards the seed → Claude calls `AskUserQuestion` → `control_request_forward` emitted.
5. Reducer → `awaiting_approval` → `canSubmit === false`, but the suppressed turn renders nothing → **no answerable dialog; card stuck "Awaiting"**.
6. User force-closes → subprocess killed → "Tool permission stream closed before response received" → Claude falls back, finishes; all written to JSONL.
7. Rejoin → JSONL replay surfaces the whole invisible turn.

[P03] removes steps 3–7 by never sending a standalone seed turn.

#### Live/reload consistency {#live-reload-consistency}

After [P03]/[P04], the carry-forward summary is visible immediately after compaction (from `compactionSeed` state) and stays visible across subsequent live messages. The first post-compact turn is the user's real message; its wire `content` array is `[seedBlock, <typed text>]`, where `seedBlock` is the marked recap. On the live path the user row shows only `<typed text>` (the recap is on the wire, not the substrate) while the summary renders from `compactionSeed`. On **reload-after-send**, the wrapper's replay reconstruction runs `splitCompactionSeed` on the raw JSONL `content`, re-marks the carry-forward block, and renders the `<typed text>` user row — fed through the same `compactionSeed` surface as live (R01 drift guard). On **reload-before-send** there is nothing in JSONL and no persisted seed ([Q02]); the session is a fresh empty session.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Old→new session hand-off (summary, preTokens) | local-data | `pendingCompactionStore` (in-memory module singleton); consumed **once** at bind (`take`) | [L02] |
| Deferred seed + carry-forward (`compactionSeed`: `{ preTokens, summary, seedPending }`) | structure | reducer state via `markCompactionSeed`, surfaced through `useSyncExternalStore`; single source of truth ([P06]) | [L02] |
| Seed wire injection | n/a (wire content, not React state) | impure `send()` wrapper prepends the marked seed *content block* to `wire.content`; user-bubble substrate untouched | — |
| Compaction progress / outcome | structure | existing `compactionProgressStore` + `useSyncExternalStore` | [L02] |

#### Terminology {#terminology}

- **Deferred seed** — the captured recap, held in `compactionSeed` state after compaction (`seedPending: true`), delivered on the user's first message rather than as its own turn.
- **Seed block** — the separate leading `content` block carrying the recap on the wire, marked with the comment sentinel `<!-- tug:compact-seed -->` so it's detected structurally and stays invisible to Claude.
- **Summarization half** — the suppressed recap-producing turn on the *old* (discarded) session.
- **Carry-forward summary** — the visible block (reusing the `compactionSeed` divider rendering, now carrying the summary text) shown at the top of the fresh session.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pure helpers: command-line builder, focus expansion, `buildCompactionSeed`/`splitCompactionSeed` round-trip | [P01], [P02], [P04] |
| **Integration (reducer over real events)** | Deferred-seed flush in `send()`; reconstruction split at the `add_user_message` replay seam; idle landing; summarization fail-safe | [P03], [P04], [P05] |
| **App-test (real Tug.app, real session)** | Drive `/compact` with/without focus mention; assert idle landing, no deadlock, live==reload | #success-criteria, #exit-criteria |

#### What stays out of tests {#test-non-goals}

- Mock-store assertion tests / fake-DOM render tests — banned by project policy; the reconstruction and flush are exercised through the real reducer over real event sequences and through the real app.
- Real-`claude` summarization quality — on-demand only; the app-test uses the standard run path and asserts mechanics (phase, transcript shape), not summary content.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. tugdeck commits name the laws touched.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Recognize `/compact` through atoms; expand focus mentions | done | 8938029f |
| #step-2 | Compact-then-wait: visible summary, idle landing, no seed turn; summarization fail-safe | done | e1321698 |
| #step-3 | Flush the deferred seed on first send (leading wire block) | done | d862be6c |
| #step-4 | Render the seed sentinel as the carry-forward summary on reload | done | a1ff213b |
| #step-5 | Integration checkpoint: real-app `/compact` drive | done | a669c669 |

#### Step 1: Recognize `/compact` through atoms; expand focus mentions {#step-1}

**Commit:** `fix(tugdeck): recognize /compact when the focus carries file mentions`

**References:** [P01] Detection through atoms, [P02] Focus expansion, (#detection-gap, #focus-expansion)

**Artifacts:**
- A pure helper (in `slash-commands.ts` or a sibling) that builds `{ name, focusText } | null` from `(draftText, draftAtoms)`, expanding file/doc/url atom `.value` into the focus and dropping image atoms.
- `performSubmit` (`tug-prompt-entry.tsx`) uses the helper so a leading slash command is detected even with trailing atoms; routes to the local responder as today.

**Tasks:**
- [ ] Add the command-line builder helper; leading token may be typed text `/name …` or a lone leading command atom, remainder may contain atoms.
- [ ] Wire `performSubmit` to use it; preserve the existing pure-text and lone-command-atom paths.
- [ ] Confirm the resolved focus reaches `buildSummarizationPrompt` via the `/compact` handler `args`.

**Tests:**
- [ ] Unit: `/compact prepare @dash/x.md plan` → `{ name:"compact", focusText:"prepare dash/x.md plan" }`.
- [ ] Unit: bare `/compact`, lone command atom, and plain text still resolve as before.
- [ ] Unit: image atom in focus is dropped; `buildSummarizationPrompt(focus)` contains the path.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` (new unit tests green).
- [ ] App-test (or manual): typing `/compact @file …` opens the progress sheet; nothing is sent to Claude as text.

---

#### Step 2: Compact-then-wait — visible summary, idle landing, no seed turn; summarization fail-safe {#step-2}

**Depends on:** #step-1

**Commit:** `fix(tugdeck): /compact shows a carry-forward summary and lands idle, no seed turn`

**References:** [P03] Compact-then-wait, [P05] Summarization fail-safe, Risk R02, (#deadlock-chain, #compact-then-wait)

**Artifacts:**
- `compactionSeed` state + `markCompactionSeed` + `mark_compaction_seed` event (`code-session-store.ts`, `reducer.ts`, `types.ts`) grow to `{ preTokens, summary, seedPending }` — the single source of truth for the deferred seed ([P06]).
- `deliverPendingCompactionSeeds` (`dev-session-restore.ts`): `take` the hand-off from `pendingCompactionStore` once, call `markCompactionSeed(summary, preTokens)` (sets `seedPending: true`), do **not** `send`, call `succeed()`; session stays idle.
- Transcript: the `compactionSeed`/`source:"compact"` rendering shows the summary as a visible carry-forward block (not just a thin divider label).
- `/compact` watcher (`dev-card.tsx`): gains an active-phase branch — on `awaiting_approval` while the summarization turn is still active → `interrupt()` + `compactionProgressStore.fail(...)`, guarded by a `failed` (run-settled) flag mirroring the existing `canceled` flag so it resolves once ([P05]).

**Tasks:**
- [ ] Extend `compactionSeed` state + `mark_compaction_seed` event to carry `summary` and `seedPending` ([P06]).
- [ ] Remove the suppressed seed `send(...)` from the bind hook; `take` the hand-off, `markCompactionSeed(summary, preTokens)`, call `succeed()`.
- [ ] Render the carry-forward summary block from `compactionSeed` state.
- [ ] Confirm the fresh session reports `phase === "idle"`, `canSubmit === true` after bind.
- [ ] Add the active-phase `awaiting_approval` fail-safe branch + `failed` settled-guard to the watcher.

**Tests:**
- [ ] Integration (reducer over real bind/turn events): after compaction bind, phase is `idle`, no pendingTurn, no `awaiting_approval`, and the carry-forward summary is present in the transcript projection.
- [ ] Integration: an `awaiting_approval` event during an active summarization turn fails the run and restores `canSubmit`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`.
- [ ] Manual: `/compact` → sheet → carry-forward summary visible, fresh session idle, composer enabled, no assistant turn, never stuck "Awaiting".

---

#### Step 3: Flush the deferred seed on first send (leading wire block) {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugdeck): deliver the compaction recap on the first post-compact message`

**References:** [P04] Seed marker, [P06] Seed ownership, (#live-reload-consistency)

**Artifacts:**
- Comment-sentinel constant + `buildCompactionSeed` emits the marked seed block (marker line + framing + summary) (`compaction-request.ts`).
- `CodeSessionStore.send()` (`code-session-store.ts`): if `compactionSeed?.seedPending`, prepend the marked seed block as `content[0]` of `wire.content`; leave the user-bubble display substrate as the typed text; then dispatch the action that flips `seedPending → false` (the summary text stays for the carry-forward).

**Tasks:**
- [ ] Prepend the seed block to `wire.content` (not into the user bubble's `synth.text`/`atoms`).
- [ ] Flip `seedPending → false` on flush so a second send carries no recap.
- [ ] Guard: a `suppress:true` programmatic send does not consume/flush the seed.

**Tests:**
- [ ] Unit: `buildCompactionSeed`/`splitCompactionSeed` round-trip; `content[0]` marker detected, summary recovered, residual blocks preserved; a non-seed first block returns `null`.
- [ ] Integration: first `send("start the dash")` after compaction → `wire.content[0]` is the marked seed block; the user bubble is just `"start the dash"`; the carry-forward summary still renders; `seedPending` is now `false`; a second send carries no seed block.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`.

---

#### Step 4: Render the seed sentinel as the carry-forward summary on reload {#step-4}

**Depends on:** #step-3

**Commit:** `fix(tugdeck): reconstruct the compaction carry-forward from JSONL on reload`

**References:** [P04] Seed marker, [P06] Seed ownership, [Q01], Risk R01, (#live-reload-consistency)

**Artifacts:**
- Shared `splitCompactionSeed(content)` helper operating on **raw `content` blocks**, returning `{ seedSummary, residualContent } | null`.
- Replay-reconstruction seam (the `add_user_message` dispatch in the store wrapper, `code-session-store.ts`): when `splitCompactionSeed(ev.content)` matches, dispatch `mark_compaction_seed` with the recovered summary and `seedPending: false` **before** `synthesizeUserMessageFromBlocks`, then synthesize only `residualContent` into the user bubble.

**Tasks:**
- [ ] Detect + split the seed block on raw `ev.content` at the replay seam; re-mark the carry-forward (`seedPending: false`) and synthesize the residual bubble.
- [ ] Ensure the live (`compactionSeed`-state) block and the reconstructed block render through the same surface (identical by construction).

**Tests:**
- [ ] Integration: feed a replay `add_user_message` whose `content[0]` is the marked seed block → carry-forward summary set + residual user bubble (no recap inside the bubble; recap never passed through synthesis).
- [ ] Integration: the live block (after a first send) and the reconstructed-from-JSONL block are equal.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`.

---

#### Step 5: Integration checkpoint — real-app `/compact` drive {#step-5}

**Depends on:** #step-1, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** [P03] Compact-then-wait, [P04] Seed marker, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Drive `/compact` and `/compact <focus with @file>` against the real Tug.app via the app-test harness (`just app-test`), no `TUG_FORCE_BUNDLE_ID`.

**Tests:**
- [ ] App-test: `/compact @file …` opens the sheet (not sent as text).
- [ ] App-test: post-compact session shows a visible carry-forward summary, is `idle`, `canSubmit === true`, zero assistant turns; never stuck `awaiting_approval`.
- [ ] App-test: first message carries the recap on the wire and renders as carry-forward summary + the typed user row; reload reconstructs an equal carry-forward summary (no raw recap in the user bubble).

**Checkpoint:**
- [ ] `just app-test` green; manual drive matches the success criteria above.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A `/compact` that is reliably recognized (even with file mentions), lands the fresh session idle and interactive with a visible carry-forward summary, never deadlocks, and renders identically live and on reload.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `/compact <focus with @file>` opens the progress sheet and resolves the path into the summarization focus (#step-1).
- [ ] Post-compaction session shows a visible carry-forward summary, is `idle` with composer enabled, and has no assistant turn (#step-2).
- [ ] No `/compact` path reaches a stuck `awaiting_approval` (#step-2, #step-3).
- [ ] The carry-forward summary renders identically live and after reload-after-send; the first message renders as its own row below it, recap not duplicated into the bubble (#step-3, #step-4).
- [ ] `cd tugrust && cargo nextest run` and `cd tugdeck && bun test` green; `just app-test` green.

**Acceptance tests:**
- [ ] App-test drive in #step-5.
- [ ] Unit + integration suites from Steps 1–4.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Collapsed-by-default carry-forward summary (one-line "Session compacted · expand"). Full-recap display is acceptable for now.
- [ ] Persist the deferred seed across a hard reload via a purpose-built mechanism, if the reload-before-first-message window proves to bite ([Q02]).
- [ ] Harden / clean up a pending approval whose store is disposed mid-flight, pending a concrete reproduction ([Q03]).
- [ ] Unify this client-driven compaction with Claude's native `compact_boundary` auto-compaction path.

| Checkpoint | Verification |
|------------|--------------|
| Detection through atoms | Unit + app-test (#step-1, #step-5) |
| No deadlock / idle landing | Integration + app-test (#step-2, #step-5) |
| Live == reload (after send) | Integration equality test + app-test (#step-4, #step-5) |
