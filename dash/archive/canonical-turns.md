<!-- devise-skeleton v4 -->

## Canonical Turns — One Authority, Then Turns Everywhere {#canonical-turns}

**Purpose:** Make "turn" a single, canonical count that every layer agrees on (Phase 1), then convert the user-facing restore window, transcript numbering, load bar, and session picker to speak turns (Phase 2). At the end, the picker's turn count, the ledger's `turn_count`, tugcode's reported `totalTurns`, and the transcript's highest turn badge are the **same number** for any session.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-15 |

---

### Plan Shape {#plan-shape}

This is a **two-phase** plan in one document. Phase 1 establishes the canonical count (approach **B**: one authority — tugcode's `turn_complete` segmentation, surfaced as the `totalTurns` it already emits on `replay_complete` — persisted in the tugcast ledger, read by everyone, reconciled-to-exact whenever the authority runs). Phase 2 is the plumbing and UI work to adopt turns as the canonical user-facing metric. Phase 2 steps depend on Phase 1 landing. There is one combined **Step Status Ledger** spanning both phases; `/tugplug:implement` walks it top to bottom.

The **load-bearing invariant** of the whole plan: **`tugcode.totalTurns == scanner total == ledger.turn_count == picker subtitle N == highest transcript turn badge`** — for any session, including a windowed restore. Every decision below exists to make that equality true by construction and to keep any one touch point from breaking it.

---

### Phase 1 Overview — Canonical Count {#phase-1-overview}

#### Context {#context-p1}

Three independent code paths currently count "turns," and they apply different rules. The tugcast Rust disk scanner (`external_sessions.rs`) increments `turn_count` for any `type:"user"` JSONL line whose content passes `is_user_submission_content` — a predicate that excludes only `tool_result` echoes. tugcode's wire/replay segmenter applies the *same* base predicate **plus** a second gate, `isNonSubmissionUserString`, that excludes `/compact` summaries, slash-command scaffolding, and `<task-notification>` wake strings, and it opens a turn for wake events. The client commits one `TurnEntry` per tugcode `turn_complete`.

For **tug-spawned / live** sessions this is already consistent: the ledger bumps `record_turn` once per *live* `turn_complete` (replay-bracketed ones are skipped), which equals what the client commits. The divergence is isolated to **never-opened external sessions** (Claude Code terminal sessions): their `turn_count` comes only from the Rust scanner's looser rule, and because replayed `turn_complete`s are excluded from `record_turn`, that estimate is never corrected even after the session is opened. A 5-prompt session that used `/compact` once reads "10 turns" in the picker but shows 5 user turns in the transcript.

Two further hazards make naïve fixes unsafe, both confirmed in the code. First, **replay is windowed** (`resolveWindow` emits only the trailing turns), so a count derived by tallying replayed `turn_complete` frames undercounts to the window — but tugcode **already emits the true `totalTurns`** on `replay_complete`, so the authority number is available for free. Second, **`record_spawn` merges `turn_count = MAX(ledger, scan_cache_seed)`** and the picker serves external rows straight from `external_scan_cache`; a stale, pre-fix cached count therefore survives the rule change and can be re-applied through the merge.

#### Strategy {#strategy-p1}

- Define the canonical turn rule **once**, as a written spec doc, so every implementation cites one source.
- Name the **authority**: tugcode's `turn_complete` segmentation, surfaced as the `totalTurns` value it already reports on `replay_complete`. That single number is what the ledger reconciles to and what every other touch point must equal.
- Make the tugcast **ledger** the single persisted value the picker reads for tug rows (and the **scan cache** the persisted value for external rows) — both produced by the canonical rule.
- Bring the Rust disk scanner into *full* spec conformance and **bump the scan-cache epoch** so no pre-fix cached count survives the rule change.
- **Reconcile** the ledger to tugcode's `totalTurns` on every `replay_complete`, so an opened session converges to canonical and stays correct even though `record_spawn`'s `MAX` seed runs first.
- **Decouple** picker visibility and the resume-vs-new gate from the *count* — key them on resumable content existing, so a (correctly) stricter count can never make a real session vanish or mis-gate.
- Build a **real-JSONL golden corpus** that the Rust scanner test and the tugcode segmenter test both assert against, and pin the full chain with a **four-way equality** test.

#### Success Criteria (Measurable) {#success-criteria-p1}

- For every fixture in the golden corpus, scanner `turn_count` == tugcode `totalTurns` == hand-verified expected value. (corpus contract tests, both languages)
- A session that uses `/compact`, a slash command, and a scheduled wake produces identical counts from scanner and segmenter. (specific corpus fixture)
- After resuming a never-opened external session, the ledger `turn_count` equals tugcode's `totalTurns` — even when the prior scan estimate or `MAX` seed differed, and even on a session where the windowed `count` differs from `totalTurns`. (reconcile integration test)
- An error `replay_complete` (missing/unreadable JSONL) does **not** alter the ledger `turn_count`. (reconcile error-frame test)
- A stale, inflated count cannot survive — not from `external_scan_cache`, not via the server `record_spawn` MAX, not via the client `dev-session-ledger-store` MAX. (cache-epoch + both-MAX tests)
- No session with resumable content (`file_size > 0`) is hidden from the picker or gated to `mode=new` because its canonical count is low. (visibility/gate regression test)
- The four-way equality holds on a real session. (equality contract test, #step-7)

#### Scope {#scope-p1}

1. A written canonical turn-rule spec in `tuglaws/`.
2. A shared real-JSONL golden corpus with expected per-session turn counts.
3. Full spec conformance for the Rust disk scanner **plus** a scan-cache epoch bump.
4. A tugcode contract test proving the segmenter matches the corpus.
5. Ledger reconciliation to tugcode's `totalTurns` on replay, with the `record_spawn` `MAX` seed provably corrected.
6. Decoupling picker visibility + resume/new gate from the count.

#### Non-goals (Explicitly out of scope) {#non-goals-p1}

- Any user-facing UI change (that is Phase 2).
- Re-deriving counts for never-opened sessions by running tugcode over every disk file (defeats the cheap-scan purpose; the scanner remains a spec-faithful estimate).
- Changing the `rewind` chop logic's `isUserSubmissionContent` use (it counts user-submission *anchors*, a related-but-distinct concept — see [#rewind-carveout]).
- Changing the wire *shape* of `SessionRow` / `CardBinding` (the `turn_count` field already exists; only the *gate* that reads it changes).

#### Dependencies / Prerequisites {#dependencies-p1}

- Access to real session JSONLs under `~/.claude/projects` that exercise `/compact`, slash commands, and wake turns (for the corpus — real fixtures only).

#### Constraints {#constraints-p1}

- Rust workspace is `-D warnings`; tests must be warning-clean (`cargo nextest run`).
- tugcode is a bun-compiled binary; changes do not take effect until rebuilt — checkpoints must rebuild it.
- Corpus fixtures must come from real session JSONLs, never fabricated transcripts.

#### Assumptions {#assumptions-p1}

- tugcode emits exactly one `turn_complete` per opened turn, and reports `totalTurns` on `replay_complete` (both already true).
- The ledger row (tug rows) and the scan cache (external rows) are the only persisted turn counts any UI reads.

---

### Phase 2 Overview — Turns as the Canonical Metric {#phase-2-overview}

#### Context {#context-p2}

With one trustworthy count in hand, the user-facing surfaces still speak inconsistent units. The restore window is sized in "message-rows" (`DEFAULT_REPLAY_WINDOW_MESSAGES`, `RequestReplay.lastMessages`); the transcript badge `#NNNN` numbers rows; the load bar's progress numerator counts *fine-grained* `turn.messages` elements while its denominator counts the row-window (the unit mismatch patched this morning in `dev-load-control-bar.tsx`); the picker shows only bytes. Phase 2 makes all of these speak turns, and replaces the flat row badge with a hierarchical turn/message address. It is de-risked by the fact that **tugcode already reports `firstLoadedTurnIndex` and `totalTurns`** on `replay_complete` — the client just doesn't consume them yet.

#### Strategy {#strategy-p2}

- Express the restore window **size** in turns end to end (protocol constant, wire field, tugcode replay honoring "last N turns" via a `lastTurns` window variant). Collapse the `ReplayWindow` union to **turns only** — `{ lastTurns } | { turnRange }` — retiring both the row-counted `lastMessages` and `olderMessages` arms (load-previous re-expressed as a `turnRange`).
- Carry the absolute **turn** base for numbering (`firstLoadedTurnIndex`, already emitted) instead of a row offset.
- Rework the load bar to count turns committed against turns requested — superseding the row/fine-grained mismatch.
- Replace the `#NNNN` badge with `#t{turn}m{message}` (turn absolute, message = index into the turn's `messages`), landing turn-level numbering first, then per-message addressing of the assistant's inline pieces.
- Show both `N turns` and byte size in the picker subtitle.
- Make the persisted scroll-anchor **depth** a turn count, not a row count: the saved depth, the window it sizes, and the relocation that re-finds it all speak turns. Only the *sub-row pixel offset* (the scroll position within the anchored turn) stays a pixel — a coordinate, never a count.

#### Success Criteria (Measurable) {#success-criteria-p2}

- The restore label reads "Restoring the most recent N turns…" and the load bar reports turns committed / turns requested, settling to the real count for a short session (no phantom full-window readout). (real-session app-test)
- Every transcript entry renders a `#t{turn}m{message}` address; the highest turn index shown equals tugcode's `totalTurns` and the picker's `N turns` for the same session. (real-session app-test, four-way equality)
- The picker subtitle shows `N turns · <size>`. (pure-logic formatter test + app-test)
- Paging in older history does not renumber a turn's message addresses (turn-local `m` is stable; only the absolute turn base shifts). (window-math unit test)

#### Scope {#scope-p2}

1. Restore-window unit conversion (protocol + wire + tugcode `lastTurns` variant); full retirement of the row unit on the wire — `lastMessages` and `olderMessages` deleted, leaving a turns-only `ReplayWindow`; the persisted anchor depth moved to turns.
2. Store fields: `restoreWindowTurns`, `firstLoadedTurnIndex` (replacing the message-row equivalents in `ReplayWindowMeta`/events/reducer).
3. `dev-restore-window.ts` sizing in turns.
4. Load bar turn-based progress + label.
5. `#t{turn}m{message}` badge formatter and wiring; per-message addressing of assistant inline blocks.
6. Picker subtitle showing turns + bytes.

#### Non-goals (Explicitly out of scope) {#non-goals-p2}

- Sub-addressing *within* a single tool call or thinking block (the `m` index stops at `turn.messages` elements).
- Sub-row scroll precision: the pixel offset *within* the anchored turn stays a pixel coordinate ([P06]). The anchor's persisted **depth** is in turns; only the intra-turn offset is pixels.
- Visually distinguishing an estimated vs reconciled picker count ([Q03], deferred).

#### Dependencies / Prerequisites {#dependencies-p2}

- Phase 1 complete: a canonical count exists, is persisted, reconciled, and the gates are decoupled from it ([P01]–[P09]).

#### Constraints {#constraints-p2}

- tugdeck tuglaws: external state enters React only via `useSyncExternalStore` [L02]; appearance via CSS/DOM [L06]; registrations in `useLayoutEffect` [L22]. See [State Zone Mapping](#state-zone-mapping).
- Use `bun` (never npm); HMR is always running for tugdeck (no manual builds); tugcode must be rebuilt after edits.
- App-level verification via `just app-test <file>` ending in a greppable `VERDICT: PASS|FAIL`; pure-logic tests via `bun test`.

#### Assumptions {#assumptions-p2}

- A turn renders as its `messages` in wire order; the user submission, when present, is `messages[0]`.
- The existing load-bar control-bar appearance machinery (`data-mode`/`data-visible`, dwell) is unchanged; only the counted unit and label change.

---

### Reference and Anchor Conventions {#reference-conventions}

This plan uses explicit `{#anchor}` headings (kebab-case, no phase numbers), plan-local decisions `[P01]`, open questions `[Q01]`, specs `S01`, risks `R01`. Steps cite artifacts by ID and anchor, never by line number. Global design decisions, if cited, use `[D##]`.

---

### Open Questions {#open-questions}

#### [Q01] Estimate vs exact for never-opened sessions (DECIDED) {#q01-estimate-vs-exact}

**Question:** Must the picker count be exact-from-authority for sessions that have never been opened in Tug?

**Why it matters:** Running tugcode's full translator over every on-disk session to get an exact count would defeat the cheap disk-scan that makes the picker fast over large project dirs.

**Resolution:** DECIDED (see [P02], [P03], [P08]). The scanner produces a *spec-faithful estimate* for never-opened sessions, pinned to the authority by the shared corpus and protected by a cache epoch; the ledger is reconciled to tugcode's exact `totalTurns` the first time the session is replayed.

#### [Q02] Window-unit conversion vs anchor math (DECIDED) {#q02-window-anchor}

**Question:** Does sizing the restore window in turns force the scroll-anchor relocation math off its current row basis?

**Resolution:** DECIDED (see [P06]). Yes — and that is correct. The anchor's persisted *depth* moves to turns alongside the window size and labels: a single turn quantity sizes the window and re-finds the anchor, with no row↔turn inequality bridging them. Only the sub-row pixel offset within the anchored turn stays a pixel. The earlier "anchor stays row-based" answer was a hedge and is reversed (#step-13).

#### [Q03] Surface "estimated" vs "reconciled" counts (DEFERRED) {#q03-estimated-badge}

**Question:** Should the picker visually mark a never-opened session's count as an estimate?

**Resolution:** DEFERRED — minor UX, and with [P03]/[P08] the estimate is spec-faithful and converges on first open. Revisit as a picker follow-on if estimates ever prove visibly wrong on real corpora.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Scanner/segmenter rule drift | high | med | Shared golden corpus asserted in both languages + four-way equality test | Any change to the turn rule |
| Window-unit conversion breaks anchor restore | med | med | Anchor depth in turns (one unit end to end); real-session app-test asserts post-resume position | Scroll position wrong after resume |
| Per-message badge noise/perf | med | low | Subdued styling; land turn-base first; measure on real session | Visible clutter or scroll jank |
| Stale tugcode binary masks changes | med | med | Checkpoints rebuild tugcode before testing | Test contradicts the edit |
| Stale scan-cache count resurrected via `MAX` | high | med | Cache epoch bump + reconcile-after-spawn + test | Picker count wrong after rule change |
| Stricter count hides/mis-gates a real session | high | low | Decouple visibility/gate from count; regression test | A resumable session vanishes |
| Client `TurnEntry` count drifts from `totalTurns` | high | med | Intra-tugcode lockstep assertion; equality stressed at dedup/orphan edges | Badge ≠ picker count after interrupt/reconnect |

**Risk R01: Cross-language rule drift** {#r01-rule-drift}

- **Risk:** The Rust scanner and the tugcode segmenter re-implement the turn rule in different languages and silently diverge again.
- **Mitigation:** One spec doc; one real-JSONL corpus; a contract test in *each* language asserting the same expected counts; the four-way equality test; reconcile-on-replay so tugcode's `totalTurns` always wins for opened sessions.
- **Residual risk:** A never-opened session can still carry an estimate until first open; bounded to the scanner's spec-faithful approximation.

**Risk R02: Anchor restoration regression** {#r02-anchor}

- **Risk:** Moving the window — and the anchor depth — to turns disturbs faithful scroll restoration.
- **Mitigation:** [P06] makes the anchor depth a turn count end to end (no row↔turn inequality to drift); relocation re-finds the anchored turn and restores the sub-row pixel offset within it; a real-session app-test asserts post-resume scroll position (#step-13, verified #step-17).
- **Residual risk:** A turn taller than the viewport restores to that turn's top plus the saved pixel offset; the offset keeps placement faithful within the turn.

**Risk R05: Stale count resurrected by a MAX (server or client)** {#r05-cache-resurrection}

- **Risk:** `external_scan_cache` rows survive the rule change and feed `record_spawn`'s server `MAX` (its seed `SELECT` is un-gated today); separately, the client `dev-session-ledger-store` backfill `Math.max`'s `turn_count`, suppressing a correct downward reconcile while a refresh scan is in flight.
- **Mitigation:** [P08] — add a `rule_epoch DEFAULT 0` column with `CURRENT_RULE_EPOCH = 1` (an `ALTER ADD COLUMN`, not the `turn_telemetry`-only self-heal rebuild) and gate `rule_epoch == CURRENT` at **both** the scan hit-check and the `record_spawn` seed read; reconcile-after-spawn so `totalTurns` is the final server value; drop the client count MAX so an authoritative push is taken as-is. Tests at all sites, including an error-replay that must not strand a seeded count.
- **Residual risk:** Between `record_spawn` and a successful `replay_complete` (sub-second) the picker may briefly show a `MAX` seed (now epoch-faithful); corrected by reconcile.

**Risk R06: Stricter count hides/mis-gates a session** {#r06-visibility-regression}

- **Risk:** The picker hides `turn_count == 0` rows and the mode gate is `turn_count > 0 || is_alive`; a correctly stricter rule could push a borderline session to 0 and make it vanish or gate to `mode=new`.
- **Mitigation:** [P09] — key visibility and the resume/new gate on resumable content (`file_size > 0` / `is_alive`), independent of the count; regression test + the `turn_count >= 1 ⇐ file_size > 0` invariant on the corpus.
- **Residual risk:** A truly content-free file (no submission, no wake) stays hidden — which is correct.

**Risk R07: Client `TurnEntry` count drifts from `totalTurns`** {#r07-client-count-drift}

- **Risk:** The four-way equality's weak link is the *client*, not tugcode. `totalTurns` and the live `turn_complete` stream share one segmentation by construction (`computeTurnStartIndices` is a dry-run of the emit path, "in lockstep"). But the reducer **dedupes `turn_complete` by msg_id** (`committedMsgIds`) and **synthesizes orphan turns on interrupt** — so the client's `TurnEntry` count, and thus the highest badge (`firstLoadedTurnIndex + localTurnIndex + 1`), equals `totalTurns` only if that reconciliation lands exactly. The dangerous cases are an interrupt at the window edge and a reconnect/orphan re-emission, which the clean-resume equality test would never exercise.
- **Mitigation:** Add the intra-tugcode lockstep assertion (#step-4); include an **interrupted-turn** fixture and a **reconnect/orphan-overlap** scenario in the four-way equality stress (#step-7, #step-17) so `highest badge == totalTurns` is checked precisely where dedup/orphan logic runs.
- **Residual risk:** Novel interrupt/reconnect interleavings outside the fixtures; bounded by the standing equality assertion, which fails loudly if the client count ever drifts.

---

### Design Decisions {#design-decisions}

#### [P01] A turn is one `turn_complete`; tugcode is the authority (DECIDED) {#p01-authority}

**Decision:** The canonical turn count equals the number of `turn_complete` events tugcode's segmenter produces, surfaced as the `totalTurns` value tugcode already reports on `replay_complete`. tugcode's segmentation rule is the single definition of "what opens a turn."

**Rationale:**
- It is already the live truth: the ledger bumps `record_turn` per live `turn_complete`, and the client commits one `TurnEntry` per `turn_complete`.
- It is the only path that sees the full, ordered wire stream with the wake/compaction/scaffolding context applied, and it already computes the total even under a window.

**Implications:**
- The disk scanner and any other counter are defined as *approximations of, or reconciliations to,* `totalTurns` — never independent rules.

#### [P02] Reconcile the ledger to `totalTurns` on replay (DECIDED) {#p02-reconcile-totalturns}

**Decision:** On a **successful** `replay_complete` (one that carries window metadata), the ledger row's `turn_count` is **set** to the frame's `totalTurns`. The picker reads that value (tug rows). Two guards are mandatory: (a) reconcile reads **`totalTurns`, never the sibling `count`** field on the same frame — `count` is the *windowed* committed-cycle tally (`ctx.turnsCommitted`) and undercounts; (b) reconcile **skips error `replay_complete` frames** (`missing`/`unreadable`/timeout), which carry `count: 0` and **no** window metadata — SETting from them would zero a real ledger count.

**Rationale:**
- `totalTurns` is the authority and is already on the wire; counting windowed frames (or grabbing `count`) is both wrong and fragile under Phase 2's turn-window.
- The error branches emit a metadata-less `replay_complete{count:0}`; a naïve `set_turn_count(totalTurns ?? 0)` on every frame would wipe the ledger on a transient reconnect failure.
- Reconcile runs *after* `record_spawn` seeds the row, so the authoritative value is always the final written one for a successfully-opened session.

**Implications:**
- The bridge parses `replay_complete`, branches on presence of window metadata, and calls a new ledger `set_turn_count` (SET, not increment) with `totalTurns` only on the success path; live `record_turn` continues for post-replay turns, building on the reconciled base.

#### [P03] The disk scanner implements the FULL rule, corpus-pinned (DECIDED) {#p03-scanner-full-rule}

**Decision:** The Rust scanner is brought into full conformance with the spec: it excludes `/compact` summaries, slash-command scaffolding, and `<task-notification>` strings from user-submission counting, and counts wake openers as turns — then is pinned to the corpus.

**Rationale:**
- Today it mirrors only `is_user_submission_content` (half the rule), so it over-counts on `/compact`/slash/scaffolding.
- A spec-faithful estimate is what makes never-opened counts trustworthy before reconciliation.

**Implications:**
- New Rust predicates mirroring `isNonSubmissionUserString` and wake detection; corpus test in tugcast.

#### [P04] Badge address is `#t{turn:4}m{message:2}` (DECIDED) {#p04-badge-format}

**Decision:** Transcript entries are addressed `#t{TURN}m{MESSAGE}` — `TURN` zero-padded to 4, `MESSAGE` to 2 — with `TURN` absolute (session-global, 1-based) and `MESSAGE` the 1-based index into that turn's `messages`. Padding is cosmetic: values overflow their width gracefully and **no parser or data assumption caps `MESSAGE` at 99 or `TURN` at 9999**.

**Rationale:**
- Mirrors the data shape (a turn contains an ordered message sequence) and resolves the old "is a turn one number or two?" ambiguity.
- Turn-local `m` is stable under windowing; only the absolute turn base shifts.

**Implications:**
- A new formatter replaces `formatSequenceNumber`; numbering base becomes turn-based.

#### [P05] `m` indexes every `turn.messages` element (DECIDED) {#p05-message-granularity}

**Decision:** `MESSAGE` enumerates every element of `turn.messages` in wire order — `user_message`, `assistant_text`, `assistant_thinking`, `tool_use`, `system_note`. The assistant's inline blocks therefore become individually addressed and individually badged.

**Rationale:**
- Gives every atomic content piece a stable address (the point of the scheme), and justifies the two-digit `m` field.

**Implications:**
- A rendering change: the single assistant row paints one (subdued) badge per inline message, not one badge for the row.

#### [P06] Window and anchor both speak turns; the wire is turns-only (DECIDED) {#p06-window-turns-anchor-rows}

**Decision:** The restore window's size, all user-facing labels, **and the persisted scroll-anchor depth** are expressed in turns — one unit, end to end. The `ReplayWindow` wire union carries **only** turn-based variants: `{ lastTurns }` (cold resume / recency) and `{ turnRange }` (explicit range, including load-previous paging). The row-counted `lastMessages` and `olderMessages` arms are deleted, as is `DEFAULT_REPLAY_WINDOW_MESSAGES`. The single quantity that remains a pixel is the sub-row scroll *offset within* the anchored turn — a coordinate, not a count.

**Rationale:**
- A turn-based window over a row-based anchor depth is two units in tension, bridged only by the inequality "every turn yields ≥1 row." That inequality is a hedge: it over-approximates the load and leaves a second unit leaking back into a turns-canonical design. Making the anchor depth a turn count removes the bridge — `resolveRestoreWindow` becomes a clean `max(anchorTurnDepth, defaultWindowTurns)` over two turn quantities.
- Keeping a row-counted wire variant alive (`lastMessages`, `olderMessages.count`) means the wire still speaks rows. The only production sender is already on `lastTurns`, load-previous is expressible as a `turnRange`, and nothing real needs the row cut — only tests did, and tests do not keep retired code alive.

**Implications:**
- `tugproto` `ReplayWindow` → `{ lastTurns: number } | { turnRange: [number, number] }`; tugcode `resolveWindow` drops the `lastMessages`/`olderMessages` branches (the two row-accumulation loops). `loadPrevious` emits `turnRange: [firstLoadedTurnIndex − N, firstLoadedTurnIndex]` and caps to `firstLoadedTurnIndex` (turns), not `firstLoadedMessageIndex` (rows).
- The saved anchor bag persists a turn depth; the generic `tug-list-view` stays turn-agnostic by taking an injected depth resolver (the transcript supplies the row→turn one; other lists keep the row default). Both window sizing and anchor relocation read the turn depth; the sub-row pixel offset is preserved for fidelity.
- This corrects the row-anchor / row-wire state shipped in #step-8–#step-10 before the badge work builds on it (#step-12, #step-13).

#### [P07] The client never recomputes a display count (DECIDED) {#p07-no-client-recompute}

**Decision:** The picker reads the persisted count — `SessionRow.turn_count` (ledger for tug rows, `external_scan_cache` for external rows, both produced by the canonical rule). The transcript's turn numbering derives from the same tugcode stream (`firstLoadedTurnIndex` + local). A contract test asserts the transcript's highest turn index equals tugcode's `totalTurns` and the ledger count for a corpus session.

**Rationale:**
- Two client-side rules would re-introduce exactly the drift this plan removes.

**Implications:**
- No standalone "count turns for the picker" code on the client; the picker's external-row path is acknowledged to read the (faithful) scan cache.

#### [P08] No MAX, server or client, outlives the authority (DECIDED) {#p08-cache-epoch}

**Decision:** Neither of the two `MAX(turn_count)` merges may pin a stale count above the authoritative value.
- **Server `record_spawn` MAX** is kept (it prevents a bare `0` insert from shadowing rich metadata), made safe by a **cache epoch** + **reconcile-after-spawn** ([P02]).
- **Cache epoch mechanism (concrete):** `external_scan_cache` columns are added by an **explicit `ALTER TABLE … ADD COLUMN … DEFAULT`** migration (`migrate_scan_cache_add_resume_columns`); the self-heal rebuild (`rebuild_table_if_schema_drifted`) is wired **only** for `turn_telemetry` and will **not** touch the scan cache. So Step 3 adds `rule_epoch INTEGER NOT NULL DEFAULT 0` via that migration idiom and sets `CURRENT_RULE_EPOCH = 1` — every pre-fix row (epoch `0 ≠ 1`) is thereby invalid. The gate `rule_epoch == CURRENT_RULE_EPOCH` is applied at **every** site that reads a `turn_count` from the cache: the cached-scan hit-check **and** `record_spawn`'s seed `SELECT` (which today filters only `session_id`/`excluded`, no epoch). A mismatched row is a miss / yields no seed, and is re-scanned faithfully on next touch.
- **Client `dev-session-ledger-store` MAX** (`turn_count: Math.max(row.turn_count, old.turn_count)` in the scan-in-progress backfill) is **dropped for the count**: the incoming row's `turn_count` is authoritative (server-reconciled) and is taken as-is; only `last_user_prompt`/`name` keep their COALESCE-style backfill. Otherwise a correct downward reconcile is suppressed in the UI while a scan is in flight.

**Rationale:**
- Changing the server `MAX` to "lower-wins" would reintroduce the zero-shadow bug it was added to fix; a faithful seed + authoritative final SET is safer.
- Gating *both* cache reads is load-bearing because reconcile skips error frames ([P02]): a resume that errors *after* `record_spawn` would otherwise leave the stale seeded count uncorrected. An un-gated seed read defeats the epoch.
- A `DEFAULT 0` column with `CURRENT = 1` is what actually invalidates here — a `DEFAULT CURRENT` column would make every stale row match the gate and self-defeat, and no rebuild fires for this table.
- The client MAX was added only to avoid scan-flicker from a transient *lower* push; with a server-authoritative count, "lower is suspect" is no longer true.

**Implications:**
- A `rule_epoch INTEGER NOT NULL DEFAULT 0` column + `CURRENT_RULE_EPOCH = 1` constant, gated at the scan hit-check **and** the `record_spawn` seed read (audit `get_scan_cache` too); the client backfill stops MAX-ing `turn_count`; tests that a stale inflated count is neither served from cache, nor seeds `record_spawn`'s MAX (even when a later replay errors), nor pinned by the client store.

#### [P09] Resumability and visibility gate on content, not count (DECIDED) {#p09-decouple-gates}

**Decision:** A turn *count* must never decide whether a session appears or how it restores. The two gates are split by the data each path actually has:
- **Picker visibility** (`dev-picker-data-source.ts` — `turn_count === 0` hide and the resumable-count tally) keys on **`file_size > 0`**, which is present on `SessionRow`.
- **Resume-vs-new gate** (`dev-session-restore.ts`, evaluated on `CardBinding`, which carries **no** `file_size`) **stays on `turn_count > 0 || is_alive`**, made safe by the invariant **`turn_count >= 1 ⇐ file_size > 0`** rather than by adding a field. This preserves the non-goal of not changing the `CardBinding` wire shape.

**Rationale:**
- A (correctly) stricter count must not make a real session disappear or restore as fresh.
- `CardBinding` has no content signal; adding one would be a wire change. The invariant gives the gate a content guarantee for free, since a session with on-disk content always opens with a genuine user submission (≥1 turn).

**Implications:**
- Change the **client** sites (`dev-picker-data-source.ts`, `dev-session-restore.ts`) — the gates are client-side, not in the Rust picker union; add the `turn_count >= 1 ⇐ file_size > 0` invariant test + a regression test that a content-bearing, low-count session still appears and resumes.

---

### Deep Dives {#deep-dives}

#### Touch-point inventory {#touch-points}

Every place a turn **count or turn unit** is produced, consumed, or displayed, and where the plan controls it. The invariant ([#plan-shape]) holds iff every row is green. The upper rows are the *count* spine (Phase 1); the lower block is the *unit* spine (Phase 2) — the restore window, anchor, load bar, load-previous prompt, and badge that must all speak turns, plus the row-unit fields they retire.

| Touch point | Role | Controlled by |
|---|---|---|
| tugcode `totalTurns` / `firstLoadedTurnIndex` on `replay_complete` | **authority** | [P01]; consumed by [P02] (reconcile) and Phase 2 (badge base) |
| tugcode live `turn_complete` → `record_turn` (+1) | live increment | unchanged; builds on reconciled base ([P02]) |
| Rust scanner `ExternalSessionMeta.turn_count` | external estimate | [P03] full rule |
| `external_scan_cache.turn_count` (keyed size/mtime) | persisted external estimate | [P08] `rule_epoch DEFAULT 0` + gate at every read |
| `record_spawn` `MAX(turn_count, seed)` (server) | resume seed merge | [P08] seed `SELECT` epoch-gated; corrected by reconcile |
| `dev-session-ledger-store` `Math.max(turn_count)` (client) | scan-refresh backfill | [P08] drop the count MAX |
| ledger reconcile (`set_turn_count` = `totalTurns`) | authoritative SET | [P02] success frame only; not `count` |
| `SessionRow` / `CardBinding.turn_count` wire | read | unchanged shape |
| picker subtitle | read | [P07], Step 16 |
| picker visibility (`==0` hidden, client) | gate | [P09] → `file_size > 0` |
| resume/new gate (`>0`, client, `CardBinding`) | gate | [P09] → `turn_count`/`is_alive` + invariant |
| client `TurnEntry` count (reducer: `committedMsgIds` dedup + orphan synthesis) | **produced** (client-side reconciliation, R07 weak link) | [R07]; stressed at interrupt/orphan edges (#step-17) |
| client badge base (`firstLoadedTurnIndex` + local) | read | Phase 2 (#step-9, #step-14) |
| `rewind` `priorSubmissions` (`isUserSubmissionContent`) | rewind anchors | [#rewind-carveout] — separate |
| **— unit spine (Phase 2) —** | | |
| restore window size (`lastTurns` / `DEFAULT_REPLAY_WINDOW_TURNS`) | window unit | turns-only wire ([P06], #step-8, #step-12) |
| persisted scroll-anchor depth | restore unit | turns; pixel offset only ([P06], #step-13) |
| load-bar progress (turns committed / requested) | display unit | turns (#step-11) |
| load-previous prompt + step ("N earlier …", `LOAD_PREVIOUS_STEP`) | display + paging unit | turns, not rows/"messages" ([P06], #step-12) |
| `#t…m…` transcript address | display | [P04]/[P05] (#step-14, #step-15) |
| `totalMessages`, `firstLoadedMessageIndex` (wire/events/`ReplayWindowMeta`) | row-unit, **retired** | no turn-canonical consumer (#step-12, #step-14) |

#### Rewind carve-out {#rewind-carveout}

`session.ts`'s chop/`priorSubmissions` logic counts `isUserSubmissionContent` *without* the `isNonSubmissionUserString` gate, because `/rewind` anchors on genuine user submissions, not on the turn metric (it intentionally does not anchor on wake turns). This is a deliberately separate concept and is **out of scope**. If Step 1's spec renames or relocates the shared predicate, keep rewind compiling against its own copy or an explicitly-shared-but-distinct helper — do not silently fold rewind into the turn rule.

---

### Specification {#specification}

#### Spec S01: Canonical turn rule {#s01-turn-rule}

A **turn** is one *committed response cycle* — exactly one tugcode `turn_complete`. A turn is **opened** by exactly one of:

- a **user submission** — a JSONL `type:"user"` record whose `message.content` is a genuine submission: `isUserSubmissionContent` is true (string content, or an array with ≥1 non-`tool_result` block) **and** `isNonSubmissionUserString` is false (not an `isCompactSummary` continuation, not slash-command scaffolding — `<command-name>`, `<command-message>`, `<command-args>`, `<local-command-stdout>`, `<local-command-caveat>` — and not a `<task-notification>` envelope);
- a **wake opener** — a `<task-notification>` envelope (Cohort A wake) that tugcode re-routes to `wake_started`.

A turn is **not** opened by: `tool_result` echoes, `/compact` summaries, slash-command scaffolding strings, or any assistant/system record. The canonical count is the number of opened turns = the number of `turn_complete` events = tugcode's reported `totalTurns`. **Wake turns count.**

#### Spec S02: Transcript address {#s02-address}

- Format: `#t{TURN:0>4}m{MESSAGE:0>2}` (padded-not-capped, [P04]).
- `TURN` = `firstLoadedTurnIndex + localTurnIndex + 1` (absolute, 1-based).
- `MESSAGE` = 1-based index into `turn.messages` ([P05]).
- Examples: turn 7 user submission `#t0007m01`; its assistant text `#t0007m02`; a thinking block `#t0007m03`; first tool call `#t0007m04`. Wake turn 12's first assistant message `#t0012m01` (no `m01` user message).

#### Spec S03: Restore window in turns {#s03-window}

- `DEFAULT_REPLAY_WINDOW_TURNS` is the sole default window size; `DEFAULT_REPLAY_WINDOW_MESSAGES` is **deleted**.
- Wire: the `ReplayWindow` union is **turns only** — `{ lastTurns: N }` (recency / cold resume) and `{ turnRange: [start, end) }` (explicit range, including load-previous as `[firstLoadedTurnIndex − N, firstLoadedTurnIndex]`). The row-counted `lastMessages` and `olderMessages` arms are removed from `tugproto`, tugcode `resolveWindow`, and all callers and tests. tugcode replay returns the most recent N **turns'** records and reports `firstLoadedTurnIndex` + `totalTurns` + `hasOlder`.
- Anchor: the persisted anchor depth is a **turn** count; `resolveRestoreWindow(anchorTurnDepth, DEFAULT_REPLAY_WINDOW_TURNS)` is a clean `max` of two turn quantities. Relocation re-finds the anchored turn and restores the sub-row pixel offset within it; no row *count* is persisted or sizes a load.
- Row-unit fields retired: `totalMessages` (no consumer) and `firstLoadedMessageIndex` (orphaned once the badge base, the load-previous prompt, and `loadPrevious` all move to `firstLoadedTurnIndex`) are removed from the wire, events, reducer, and `ReplayWindowMeta`.
- Load-previous affordance: counts and names **turns** — "There {is|are} N earlier turn{s}…", stepping by `LOAD_PREVIOUS_STEP` turns — never "earlier messages".
- Load bar: denominator = requested turns; numerator = turns committed in the loaded window (count of `TurnEntry`); on completion, report the real turns loaded (a short session shows "3 of 3 turns", never a phantom full window).
- Label: "Restoring the most recent N turns…".

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `firstLoadedTurnIndex` (numbering base) | local-data | store snapshot → `useSyncExternalStore` | [L02] |
| `restoreWindowTurns` / turns-committed (load bar) | local-data | store snapshot → `useSyncExternalStore` | [L02] |
| Picker `turn_count` | local-data | wire `SessionRow` → store → `useSyncExternalStore` | [L02] |
| `#t…m…` badge text | structure (derived render) | pure render from store data; no React state | [L02] |
| Load-bar mode / visibility | appearance | existing `data-mode`/`data-visible` DOM attrs | [L06], [L22] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tuglaws/turn-metric.md` | The canonical turn-rule spec (S01) and address scheme (S02). |
| `tugrust/crates/tugcast/tests/fixtures/turns/` (corpus) | Real-JSONL golden corpus + expected counts (shared intent). |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `is_non_submission_user_string` | fn | `tugcast/src/external_sessions.rs` | Mirror of tugcode's gate ([P03]). |
| wake detection in scan loop | logic | `tugcast/src/external_sessions.rs` | Count wake openers; exclude scaffolding/compact ([P03]). |
| `rule_epoch DEFAULT 0` + `CURRENT_RULE_EPOCH=1` | schema/const | `tugcast/src/session_ledger.rs` (`external_scan_cache`) | `ALTER ADD COLUMN` (not self-heal); gate at every cache count read ([P08]). |
| `set_turn_count` | fn | `tugcast/src/session_ledger.rs` | Authoritative SET to `totalTurns` ([P02]). |
| `record_spawn` MAX merge (server) | logic | `tugcast/src/session_ledger.rs` | Kept; seed `SELECT` epoch-gated; corrected by reconcile ([P08]). |
| reconcile on success `replay_complete` | logic | `tugcast/src/feeds/agent_bridge.rs` | Branch on window metadata; read `totalTurns`, not `count`; skip error frames ([P02]). |
| picker visibility / resumable tally | logic | `tugdeck/.../dev-picker-data-source.ts` | Gate on `file_size > 0` ([P09]). |
| resume/new gate (`CardBinding`) | logic | `tugdeck/.../dev-session-restore.ts` | Keep `turn_count`/`is_alive`; invariant-protected ([P09]). |
| client `turn_count` MAX | logic | `tugdeck/.../dev-session-ledger-store.ts` | Drop the count MAX; take authoritative value ([P08]). |
| corpus contract + four-way equality test | test | `tugcast` + `tugcode` + app-test | Same expected counts; full-chain equality (R01). |
| `DEFAULT_REPLAY_WINDOW_TURNS` | const | `tugdeck/src/protocol.ts` | Sole default window size; `DEFAULT_REPLAY_WINDOW_MESSAGES` deleted ([P06], #step-12). |
| turns-only `ReplayWindow` (`{lastTurns}\|{turnRange}`) | type/logic | `tugproto/src/inbound.ts` + tugcode `resolveWindow` | `lastMessages` + `olderMessages` deleted; load-previous → `turnRange` ([P06], #step-12). |
| `restoreWindowTurns` | field | `code-session-store` | Replaces `restoreWindowMessages`. |
| `firstLoadedTurnIndex` | field | `ReplayWindowMeta` / events / reducer | Consume tugcode's existing report. |
| window sizing + anchor depth in turns | fns | `dev-restore-window.ts`, `tug-list-view.tsx`, `card-services-store.ts` | Clean `max`; relocation re-finds the turn; pixel offset only ([P06], #step-13). |
| load-previous prompt + step in turns | logic | `dev-load-control-bar.tsx`, `dev-load-control-bar-state.ts` | "N earlier turns"; step in turns; feeds turn-based `loadPrevious` ([P06], #step-12). |
| retire `totalMessages` / `firstLoadedMessageIndex` | cleanup | tugcode `replay.ts`/`types.ts`, `events.ts`, reducer, `ReplayWindowMeta` | Row-unit wire/store fields with no turn-canonical consumer ([P06], #step-12, #step-14). |
| turn-based numerator/label | logic | `dev-load-control-bar.tsx` | Supersedes the row/fine-grained patch. |
| `formatTurnMessageAddress` | fn | `tug-transcript-entry.tsx` | Replaces `formatSequenceNumber` ([P04]). |
| per-message badge render | logic | `dev-card-transcript.tsx` | One badge per inline message ([P05]). |
| picker subtitle `N turns` | fn | `dev-picker-format.ts` | Adds turns beside size ([P07]). |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When |
|----------|---------|------|
| Golden / Contract | Scanner & segmenter counts match the corpus; four-way equality | Phase 1 rule conformance |
| Unit | Window math, address formatter, turn-count derivation | Pure logic both phases |
| Integration (Rust) | Reconcile-on-replay; cache-epoch; visibility/gate | Phase 1 ledger paths |
| Real-app (`just app-test`) | Picker count == highest badge == `totalTurns`; load bar/window in turns | Phase 2 user-facing |

#### What stays out of tests {#test-non-goals}

- No mock-store assertion or call-count tests; no fake-DOM/RTL render tests (banned patterns).
- Address rendering and the four-way equality on a windowed session are verified in a real app-test, not a jsdom harness.
- The formatter/window math are tested as pure functions (`bun test`), not through React.
- Corpus fixtures are real session JSONLs only — never fabricated.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Integration-checkpoint steps use `Commit: N/A (verification only)`.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Author the canonical turn-rule spec | done | 2d83c17e |
| #step-2 | Build the real-JSONL golden corpus | done | b67f72bf |
| #step-3 | Scanner full rule + scan-cache epoch | done | d624fd89 |
| #step-4 | tugcode segmenter contract test | done | 1102bb3a |
| #step-5 | Reconcile ledger to `totalTurns` on replay | done | 36f43abb |
| #step-6 | Decouple visibility + resume/new gate from count | done | a1745c80 |
| #step-7 | Phase 1 integration + four-way equality | done | verification |
| #step-8 | Restore window unit → turns (protocol + wire + replay) | done | fb3f2663 |
| #step-9 | Store: restoreWindowTurns + firstLoadedTurnIndex | done | 42603e43 |
| #step-10 | Window sizing in turns (dev-restore-window) | done | 42603e43 |
| #step-11 | Load bar speaks turns | done | 1fc0a582 |
| #step-12 | Retire the row unit on the wire (turns-only `ReplayWindow`) | done | 7f9f17a8 |
| #step-13 | Canonicalize the restore anchor to turns | done | 6ede129e |
| #step-14 | `#t…m…` badge formatter + turn-based base | done | 7f8c4310 |
| #step-15 | Per-message badge rendering | done | 2407f988 |
| #step-16 | Picker subtitle shows turns + bytes | done | 19dbd7db |
| #step-17 | Phase 2 integration + windowed equality | done | e51bf042 |

---

#### Step 1: Author the canonical turn-rule spec {#step-1}

**Commit:** `docs(turns): canonical turn-rule + address spec in tuglaws`

**References:** [P01] authority, [P04] badge format, [P05] message granularity, Spec S01, Spec S02, (#context-p1, #rewind-carveout)

**Artifacts:**
- `tuglaws/turn-metric.md` — the written rule (S01), address scheme (S02), the `totalTurns` authority flow, and the rewind carve-out.

**Tasks:**
- [ ] Write the rule exactly as S01 (open / not-open lists, wake counts), citing the existing predicates by name.
- [ ] Write the address scheme S02 (turn absolute, message into `turn.messages`, padded-not-capped).
- [ ] State the authority/ledger/scanner/cache relationship ([P01]/[P02]/[P03]/[P08]) and the four-way equality invariant.
- [ ] Note the rewind carve-out ([#rewind-carveout]).

**Tests:**
- [ ] N/A (doc) — reviewed against the code predicates it names.

**Checkpoint:**
- [ ] `tuglaws/turn-metric.md` exists and every predicate/field it references (`isUserSubmissionContent`, `isNonSubmissionUserString`, `totalTurns`) resolves to real code.

---

#### Step 2: Build the real-JSONL golden corpus {#step-2}

**Depends on:** #step-1

**Commit:** `test(turns): real-JSONL golden corpus with expected counts`

**References:** Spec S01, Risk R01, (#strategy-p1)

**Artifacts:**
- Real session JSONLs (copied/redacted from `~/.claude/projects`) covering: plain user turns only; a `/compact`; a slash command; a scheduled wake; tool_result echoes; an **interrupted turn** (for the dedup/orphan seam, [R07]); and at least one **windowed-size** session (more turns than the default window). Each paired with a hand-verified expected turn count, and — for the windowed-size session — both the expected windowed `count` and the expected `totalTurns` (they must differ, so a wrong-field reconcile fails).

**Tasks:**
- [ ] Select real sessions for each case; record the expected count per file (derived by reading the JSONL against S01).
- [ ] For the windowed-size fixture, record the expected `count` (windowed) and `totalTurns` (total) separately.
- [ ] Place fixtures where both the tugcast Rust test and the tugcode test can read them.

**Tests:**
- [ ] A manifest test asserting each fixture loads and has a recorded expectation (guards against an empty/missing corpus).

**Checkpoint:**
- [ ] Corpus present; each fixture has an expected count; `cd tugrust && cargo nextest run -p tugcast` discovers the fixtures.

---

#### Step 3: Scanner full rule + scan-cache epoch {#step-3}

**Depends on:** #step-2

**Commit:** `fix(tugcast): scanner counts turns by the full rule; bump cache epoch`

**References:** [P03] scanner full rule, [P08] cache epoch, Spec S01, Risks R01, R05, (#context-p1)

**Artifacts:**
- `is_non_submission_user_string` (Rust mirror) + wake detection in `external_sessions.rs`; a `rule_epoch INTEGER NOT NULL DEFAULT 0` column on `external_scan_cache`, a `CURRENT_RULE_EPOCH = 1` constant, and epoch-gating at every cache `turn_count` read.

**Tasks:**
- [ ] Add the exclusion predicate: `isCompactSummary`, the scaffolding prefixes, and `<task-notification>` strings do not count as user submissions.
- [ ] Count wake openers as turns so the rule matches the segmenter.
- [ ] Add `rule_epoch INTEGER NOT NULL DEFAULT 0` to `external_scan_cache` via the existing `migrate_scan_cache_add_*` ALTER idiom (the self-heal rebuild is `turn_telemetry`-only and will not fire here), and set `CURRENT_RULE_EPOCH = 1` so pre-fix rows (epoch 0) are invalid; new scans write the current epoch.
- [ ] Gate `rule_epoch == CURRENT_RULE_EPOCH` at **every** site that reads a `turn_count` from the cache: the cached-scan hit-check **and** `record_spawn`'s seed `SELECT` (add the filter); audit `get_scan_cache` for the same.

**Tests:**
- [ ] Corpus contract test: scanner `turn_count` equals expected for every fixture (especially `/compact` + slash + wake).
- [ ] Cache-epoch test: a row at a prior `rule_epoch` (0) is a miss in the scan **and** is not used as a `record_spawn` seed — verified to survive even when a subsequent replay errors (no stale MAX left behind).
- [ ] Existing `external_sessions` tests updated where they asserted the old looser count.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green, warning-clean.

---

#### Step 4: tugcode segmenter contract test {#step-4}

**Depends on:** #step-2

**Commit:** `test(tugcode): segmenter totalTurns matches corpus`

**References:** [P01] authority, [P07] no client recompute, Spec S01, Risk R01

**Artifacts:**
- A tugcode test that runs the replay translator over each corpus fixture and reads `totalTurns` from `replay_complete`.

**Tasks:**
- [ ] Feed each fixture through the translator; assert `totalTurns` equals the expected value.
- [ ] Cross-check the expected values are identical to the ones the Rust test asserts (same corpus, same numbers).
- [ ] **Intra-tugcode consistency:** on a *full* (unwindowed) replay, assert `totalTurns` (from `computeTurnStartIndices`) equals the count of emitted `turn_complete` frames — proving the boundary locator and the emit path can't drift ([R07]).

**Tests:**
- [ ] Per-fixture assertion in tugcode's test suite.
- [ ] `totalTurns == emitted turn_complete count` on a full replay of each fixture.

**Checkpoint:**
- [ ] tugcode tests green; `totalTurns` equals the Rust scanner's `turn_count` for every fixture.

---

#### Step 5: Reconcile ledger to `totalTurns` on replay {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `feat(tugcast): reconcile ledger turn_count to totalTurns on replay`

**References:** [P02] reconcile (success-frame, `totalTurns` not `count`), [P08] no MAX outlives authority, Spec S01, Risk R05, (#touch-points)

**Artifacts:**
- Bridge parsing of a **successful** `replay_complete`'s window metadata; a `set_turn_count` ledger method (SET, not increment); the reconcile call wired on each live success frame.

**Tasks:**
- [ ] In `agent_bridge.rs`, on a live (non-nested) `replay_complete`, branch on window-metadata presence: **success** → read `totalTurns` (NOT the sibling `count`, which is the windowed `turnsCommitted`) and call `set_turn_count`; **error frame** (no metadata, `count:0`) → do nothing.
- [ ] Add `set_turn_count` to `session_ledger.rs` (overwrites `turn_count`; bumps `last_used_at`).
- [ ] Confirm ordering: `record_spawn` (MAX seed) runs first, reconcile SETs after — final value is `totalTurns`. Live `record_turn` continues for post-replay turns.

**Tests:**
- [ ] tugcast integration test: resume the **windowed-size** fixture (where `count` ≠ `totalTurns`); assert the ledger row equals `totalTurns`, not `count`.
- [ ] Error-frame test: a `replay_complete{missing|unreadable}` leaves `turn_count` unchanged (no zeroing).
- [ ] Assert a stale inflated `MAX` seed does not survive the resume (final value == `totalTurns`).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green; reconcile + error-frame + seed-correction tests pass.

---

#### Step 6: Client-side count hygiene — gates + merge {#step-6}

**Depends on:** #step-3, #step-5

**Commit:** `fix(picker): gate on content, drop client turn_count MAX`

**References:** [P08] no MAX outlives authority, [P09] decouple gates, Risks R05, R06, (#touch-points)

**Artifacts:**
- `dev-picker-data-source.ts` visibility/resumable-count gated on `file_size > 0` (not `turn_count`); `dev-session-restore.ts` resume/new gate kept on `turn_count > 0 || is_alive` (no `CardBinding` wire change); `dev-session-ledger-store.ts` backfill no longer `Math.max`-es `turn_count`.

**Tasks:**
- [ ] In `dev-picker-data-source.ts`, replace the `turn_count === 0` hide (and the resumable-count tally) with `file_size > 0`.
- [ ] In `dev-session-restore.ts`, keep the `turn_count > 0 || is_alive` gate (relying on the invariant); update its docstring to say the count is a proxy guaranteed by the invariant, not the gate's true basis.
- [ ] In `dev-session-ledger-store.ts`, take the incoming `turn_count` as authoritative (drop the `Math.max`); keep the prompt/name backfill.

**Tests:**
- [ ] Pure-logic: a content-bearing (`file_size > 0`), zero/low-count row is still visible and counts as resumable; a downward-reconciled push is reflected as-is during a refresh scan (no MAX pin).
- [ ] Invariant test over the corpus: every fixture with `file_size > 0` has `turn_count >= 1`.

**Checkpoint:**
- [ ] `bun test` green; `bun run check` clean; `cd tugrust && cargo nextest run` green (invariant fixture).

---

#### Step 7: Phase 1 integration + four-way equality {#step-7}

**Depends on:** #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** [P01], [P02], [P08], [P09], Risk R01, (#success-criteria-p1, #plan-shape)

**Tasks:**
- [ ] Verify scanner total, tugcode `totalTurns`, and reconciled ledger agree on every corpus fixture (including the windowed-size one where `count` ≠ `totalTurns`).
- [ ] Live spot-check: spawn, run 2–3 turns incl. a slash command, confirm ledger == transcript `turn_complete` count.
- [ ] Stress the count-divergence paths: a **reconnect** (re-replay → success frame re-SETs `totalTurns`, no drift), a **mid-scan refresh** (client store reflects an authoritative push without MAX-pinning), an **error replay** (ledger unchanged), and the **dedup/orphan seam** ([R07]) — an interrupted turn at the window edge and a reconnect/orphan re-emission must leave `highest badge == totalTurns`.
- [ ] Confirm no corpus session with content is hidden or mis-gated.

**Tests:**
- [ ] Four-way equality assertion on a real session: `scanner total == tugcode totalTurns == ledger turn_count == picker subtitle N`, holding across a reconnect, a mid-scan refresh, and an interrupt/orphan re-emission.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` green; tugcode tests green; equality assertion passes; live spot-check matches.

---

#### Step 8: Restore window unit → turns {#step-8}

**Depends on:** #step-7

**Commit:** `feat(replay): size the restore window in turns`

**References:** [P06] window turns/anchor rows, Spec S03, (#context-p2)

**Artifacts:**
- `DEFAULT_REPLAY_WINDOW_TURNS` and a `lastTurns` `ReplayWindow` variant in `protocol.ts`; tugcode `resolveWindow` honoring "last N turns" and reporting `firstLoadedTurnIndex`/`totalTurns`/`hasOlder`.

**Tasks:**
- [ ] Add the protocol constant and the `lastTurns` window variant beside `lastMessages`.
- [ ] Extend tugcode's `resolveWindow` to select the most recent N turns directly (it already cuts at turn boundaries and reports the turn offsets).
- [ ] Rebuild tugcode.

**Tests:**
- [ ] tugcode replay test: `lastTurns: N` returns exactly the last N turns' records (corpus fixture) with the correct `firstLoadedTurnIndex` and `totalTurns`.

**Checkpoint:**
- [ ] tugcode rebuilt; replay test green; `bun run check` clean in tugdeck.

---

#### Step 9: Store — restoreWindowTurns + firstLoadedTurnIndex {#step-9}

**Depends on:** #step-8

**Commit:** `refactor(store): turns-based replay window + numbering base`

**References:** [P06], [P07], Spec S03, (#state-zone-mapping)

**Artifacts:**
- `restoreWindowTurns` (replacing `restoreWindowMessages`) and `firstLoadedTurnIndex` consumed from `replay_complete` into `ReplayWindowMeta` / events / reducer / snapshot.

**Tasks:**
- [ ] Replace the message-row fields with their turn equivalents through events.ts → reducer.ts → types.ts → snapshot.
- [ ] Keep references `Object.is`-stable per [L02] (no spurious snapshot churn).

**Tests:**
- [ ] Reducer unit test: a replay event carrying `firstLoadedTurnIndex`/`totalTurns`/`hasOlder` projects onto the snapshot with stable identity across quiescent rebuilds.

**Checkpoint:**
- [ ] `bun run check` clean; reducer tests green (`bun test`).

---

#### Step 10: Window sizing in turns (dev-restore-window) {#step-10}

**Depends on:** #step-9

**Commit:** `refactor(restore): window size in turns, anchor stays rows`

**References:** [P06] window turns/anchor rows, Spec S03, Risk R02, (#q02-window-anchor)

**Artifacts:**
- `dev-restore-window.ts` helpers sizing the resume window in turns; anchor `depthFromEnd`/relocation kept row-based.

**Tasks:**
- [ ] Convert `resolveRestoreWindow` and the default to turns; document the unit in the module header.
- [ ] Leave `anchorDepthFromEnd` / `anchorRowIndexInWindow` on rows; bridge at the call site.

**Tests:**
- [ ] Unit: window resolves to the default turns when the anchor is within it, deeper when parked above; anchor relocation still lands the saved row.

**Checkpoint:**
- [ ] `bun test` for the window math green; `bun run check` clean.

---

#### Step 11: Load bar speaks turns {#step-11}

**Depends on:** #step-9

**Commit:** `feat(load-bar): report turns committed of turns requested`

**References:** Spec S03, [P07], (#context-p2)

**Artifacts:**
- `dev-load-control-bar.tsx` restore branch counting turns: numerator = `TurnEntry` count in the loaded window, denominator = requested turns; completion reports the real turns loaded. Label "Restoring the most recent N turns…".

**Tasks:**
- [ ] Replace the fine-grained `turn.messages.length` numerator with a turn count (supersedes the earlier row/fine-grained patch).
- [ ] Use `restoreWindowTurns` as the denominator; on completion set both to the actual turns loaded.
- [ ] Update the label and the `formatValue` readout to read "turns".

**Tests:**
- [ ] Pure-logic test of the restore branch's value/max selection for active vs landed, full vs short session.

**Checkpoint:**
- [ ] `bun run check` clean; load-bar value/format unit test green.

---

#### Step 12: Retire the row unit on the wire {#step-12}

**Depends on:** #step-8

**Commit:** `refactor(replay): turns-only ReplayWindow; drop row-counted windows`

**References:** [P06] turns-only wire, Spec S03, (#touch-points, #symbol-inventory)

**Artifacts:**
- `tugproto/src/inbound.ts` `ReplayWindow` → `{ lastTurns: number } | { turnRange: [number, number] }`; tugcode `resolveWindow` loses the `lastMessages`/`olderMessages` branches; `code-session-store.ts` `loadPrevious` emits a `turnRange`; `dev-load-control-bar.tsx` + `dev-load-control-bar-state.ts` count and name the load-previous prompt in turns; `tugdeck/src/protocol.ts` loses `DEFAULT_REPLAY_WINDOW_MESSAGES`; tugcode stops emitting `totalMessages`.

**Tasks:**
- [ ] Delete the `lastMessages` and `olderMessages` arms from the `ReplayWindow` union and the two matching row-accumulation branches in tugcode `resolveWindow`. Keep `lastTurns` and `turnRange`.
- [ ] Re-express `loadPrevious(amount)` as `turnRange: [max(0, firstLoadedTurnIndex − N), firstLoadedTurnIndex]`, with the cap and the progress target in **turns** (`firstLoadedTurnIndex`), not `firstLoadedMessageIndex` (rows).
- [ ] **Convert the load-previous control bar in the same commit** (it feeds `loadPrevious` its `amount`): `earlierCount` and the `LOAD_PREVIOUS_STEP` step read `firstLoadedTurnIndex` (turns), and the prompt reads **"There {is|are} N earlier turn{s}…"** — not "earlier messages". Leaving it in rows is a unit-mismatch bug (asks for N messages, loads N turns).
- [ ] Delete `DEFAULT_REPLAY_WINDOW_MESSAGES`. Stop emitting/plumbing `totalMessages` (tugcode `replay.ts` + `types.ts`, `events.ts`, reducer, `ReplayWindowMeta`) — it has no consumer.
- [ ] Rewrite every test that referenced the removed arms to the turns-only equivalents — load-all becomes `lastTurns`/`turnRange`, backward paging becomes `turnRange`. A test does not keep a deleted arm breathing.
- [ ] Rebuild tugcode (`bun build --compile`) so the binary matches the wire.

**Tests:**
- [ ] `tugcode` `bun test` green with the row-window tests converted; `tugdeck` load-previous test asserts a `turnRange` request; the load-previous prompt formatter test reads "N earlier turns"; the turn-corpus contract still proves `totalTurns` per fixture via a turns-only load-all.

**Checkpoint:**
- [ ] A repo grep for `lastMessages`, `olderMessages`, `DEFAULT_REPLAY_WINDOW_MESSAGES`, `totalMessages`, and the string "earlier message" across `tugproto`/`tugcode`/`tugdeck` returns nothing; `bun test` + `bunx tsc --noEmit` clean; tugcode rebuilt.

---

#### Step 13: Canonicalize the restore anchor to turns {#step-13}

**Depends on:** #step-10, #step-12

**Commit:** `refactor(restore): anchor depth in turns, not rows`

**References:** [P06] anchor in turns, [Q02], Risk R02, Spec S03, (#state-zone-mapping)

**Artifacts:**
- `tug-list-view.tsx` persists a turn-based anchor depth (via an injected depth resolver so the generic list-view stays turn-agnostic); `dev-restore-window.ts` `resolveRestoreWindow` becomes a clean turn `max` and relocation re-finds the anchored turn; `card-services-store.ts` reads the turn depth.

**Tasks:**
- [ ] Replace the row-counted `depthFromEnd` in the saved anchor bag with a **turn** depth, captured at save time where the row→turn map exists (the transcript supplies the resolver; the generic list-view keeps a row default for non-transcript lists).
- [ ] `resolveRestoreWindow(anchorTurnDepth, defaultWindowTurns)` → a clean `max` of two turn counts; delete the row↔turn inequality reasoning from the module doc.
- [ ] Relocation: find the row whose turn matches the saved depth, then restore the sub-row pixel `offset` within it. The pixel offset is the only non-turn quantity that survives.
- [ ] Rewrite `dev-restore-window` unit tests over turn depths.

**Tests:**
- [ ] `dev-restore-window` pure-logic tests over turn depths (clean `max`, no inequality); the real-session post-resume scroll-position app-test (R02) lands in #step-17.

**Checkpoint:**
- [ ] `bun test` restore-window green; `bunx tsc --noEmit` clean; HMR resume lands on the saved turn with its in-turn offset.

---

#### Step 14: `#t…m…` badge formatter + turn-based base {#step-14}

**Depends on:** #step-9, #step-13

**Commit:** `feat(transcript): turn/message address badge`

**References:** [P04] badge format, Spec S02, (#state-zone-mapping)

**Artifacts:**
- `formatTurnMessageAddress(turn, message)` in `tug-transcript-entry.tsx` (replacing `formatSequenceNumber`); `dev-card-transcript.tsx` numbering the user row (`m01`) and assistant row from `firstLoadedTurnIndex` (`useMessageNumberBase` switches off `firstLoadedMessageIndex`); retirement of the now-orphaned `firstLoadedMessageIndex`.

**Tasks:**
- [ ] Add the formatter (`#t{turn:0>4}m{message:0>2}`, padded-not-capped); remove/redirect `formatSequenceNumber`.
- [ ] Derive `TURN` from `firstLoadedTurnIndex + localTurnIndex + 1`, where `localTurnIndex` spans the loaded **and** live turns — so a live turn committed after replay carries `totalTurns + k` (== the ledger after `k` `record_turn`s), never a window-local reset. User row carries `m01`. The numbering base (`useMessageNumberBase`) reads `firstLoadedTurnIndex`, not `firstLoadedMessageIndex`.
- [ ] With the badge base, the load-previous prompt (#step-12), and `loadPrevious` (#step-12) all off `firstLoadedMessageIndex`, **retire it** from tugcode (`replay.ts`, `types.ts`), `events.ts`, the reducer, and `ReplayWindowMeta` — it has no remaining consumer.
- [ ] Keep this step at row granularity (user `m01`, assistant block `m02`) to isolate the formatter from the rendering change.

**Tests:**
- [ ] Formatter unit tests incl. overflow (`m100`, `t10000`) and wake turn (no `m01` user).

**Checkpoint:**
- [ ] `bun test` formatter green; `bun run check` clean; HMR shows `#t…m…` on rows; a repo grep for `firstLoadedMessageIndex` returns nothing.

---

#### Step 15: Per-message badge rendering {#step-15}

**Depends on:** #step-14

**Commit:** `feat(transcript): address each inline message in a turn`

**References:** [P05] message granularity, Spec S02, Risk R03, (#context-p2)

**Artifacts:**
- The assistant row paints one subdued `#t{turn}m{message}` address per `turn.messages` element (text, thinking, each tool call), `message` = its index in the array.

**Tasks:**
- [ ] Render a badge per inline message segment, indexed into `turn.messages`.
- [ ] Apply subdued styling so the addresses don't overwhelm content.

**Tests:**
- [ ] Real-app: open a session with a multi-tool turn; confirm sequential `m` indices within the turn.

**Checkpoint:**
- [ ] `just app-test <transcript-address-test>` ends `VERDICT: PASS`; addresses increment within a turn and reset across turns.

---

#### Step 16: Picker subtitle shows turns + bytes {#step-16}

**Depends on:** #step-7

**Commit:** `feat(picker): show turn count beside session size`

**References:** [P07] no client recompute, [P09] decouple gates, (#success-criteria-p2)

**Artifacts:**
- `formatSessionRowSubtitle` rendering `[timestamp, N turns, size, id]`, reading `row.turn_count` (no client recompute).

**Tasks:**
- [ ] Add the `N turns` segment (singular/plural) from `SessionRow.turn_count`, beside the existing byte size.
- [ ] Update the module comment that currently says size is "deliberately not a turn count".

**Tests:**
- [ ] Pure-logic formatter test: subtitle includes both turns and size; pluralization correct; segments dropped when absent.

**Checkpoint:**
- [ ] `bun test` formatter green; `bun run check` clean; HMR shows `… · N turns · <size> · id …`.

---

#### Step 17: Phase 2 integration + windowed equality {#step-17}

**Depends on:** #step-11, #step-12, #step-13, #step-15, #step-16

**Commit:** `N/A (verification only)`

**References:** [P04], [P06], [P07], Risk R01, (#success-criteria-p2, #plan-shape)

**Tasks:**
- [ ] On a real **windowed** session: resume it, confirm the load bar reads "N of N turns", the restore label says turns, the highest transcript turn badge equals `totalTurns` and the picker's `N turns`, and paging older history doesn't renumber a turn's `m` addresses.

**Tests:**
- [ ] Real-app aggregate asserting the four-way equality on a windowed session: `highest turn badge == tugcode totalTurns == ledger turn_count == picker subtitle N`, holding across a reconnect, a mid-scan refresh, an **interrupted turn at the window edge**, and a **reconnect/orphan re-emission** ([R07]).

**Checkpoint:**
- [ ] `just app-test <turns-end-to-end-test>` ends `VERDICT: PASS`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A single canonical turn count produced by tugcode (`totalTurns`), persisted in the ledger, reconciled on replay, faithfully estimated and cache-epoch-guarded by the disk scanner, decoupled from the visibility/resume gates — and surfaced consistently in the restore window, load bar, transcript address (`#t…m…`), and picker subtitle.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Scanner total, tugcode `totalTurns`, and reconciled ledger agree on every corpus fixture and on a live session. (#step-7)
- [ ] A stale inflated scan-cache count cannot survive the rule change or a resume. (#step-3, #step-5)
- [ ] No content-bearing session is hidden or mis-gated by a low count. (#step-6)
- [ ] Restore window, load bar, and labels are in turns; a short session shows the real count. (#step-17)
- [ ] Every transcript entry shows a `#t…m…` address; highest turn index equals `totalTurns` and the picker count. (#step-17)
- [ ] Picker subtitle shows `N turns · <size>`. (#step-16)
- [ ] The `ReplayWindow` wire union and the persisted restore anchor are turns-only; no `lastMessages`, `olderMessages`, `DEFAULT_REPLAY_WINDOW_MESSAGES`, or row-counted anchor depth remains anywhere in the stack. (#step-12, #step-13)

**Acceptance tests:**
- [ ] Rust: `cargo nextest run` green (corpus + reconcile + cache-epoch + visibility).
- [ ] tugcode: segmenter `totalTurns` matches the corpus.
- [ ] tugdeck: window/formatter `bun test` green; `just app-test` end-to-end `VERDICT: PASS` (four-way equality, windowed).

#### Roadmap / Follow-ons (Not required for phase close) {#roadmap}

- [ ] [Q03] Visually mark estimated (never-opened) vs reconciled picker counts.
- [ ] Sub-addressing within a tool call / thinking block (beyond `turn.messages` granularity).

| Checkpoint | Verification |
|------------|--------------|
| Canonical count agrees across stack | `cargo nextest run` + tugcode corpus test + equality assertion |
| Stale cache cannot resurrect | cache-epoch + reconcile tests |
| No session lost to a low count | visibility/gate regression test |
| Turns surfaced end to end | `just app-test` windowed equality `VERDICT: PASS` |
