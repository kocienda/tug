<!-- devise-skeleton v4 -->

## Tool-Block Renderer Consistency Sweep {#tool-block-renderers}

**Purpose:** Bring the Agent / Agent Explore tool-block renderer back onto the shared `ToolBlockChrome` mechanism — count badge, dot-only status, single fold, a working body — and generalize the same three rules across the whole tool-block subsystem so renderers stay consistent and cheap to maintain.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-18 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The tool-block subsystem already has a clean consistency layer: every per-tool block wraps `ToolBlockChrome`, which renders one `ToolCallHeader` ("the Quiet Line") with a single trailing **badge slot** (`resultSummary`), a single **lifecycle dot** (per global decision [D02], the *only* in-flight status signal), and a single **whole-block chevron** owned by the chrome. `Read` reports `936 lines`, `Edit` reports `+N −M`, `Bash` reports its exit code — all through the one badge slot; the dot carries status; the chevron is the only fold.

`TaskToolBlock` (the Agent renderer) drifted off all three. It hand-rolls agent-type + status text into `argsSummary` (so the green `Completed` lands mid-row in the detail column instead of in the badge slot); it routes the nested-call count through a *second* fold control (`AgentTranscriptBlock`'s `BlockFoldCue`, `createPortal`-ed into the chrome's actions slot) which both duplicates the chrome chevron and is invisible until expanded; and its streaming/expanded body is empty, collapsing to a 1px marker before any nested tool runs. Two smaller wrappers (`cron`, `task-mgmt`) and one mode of `notebook-edit` render result/lifecycle text in body `status` field rows rather than the badge slot, and ~30 stale references to a never-built `StreamingPlaceholder` litter docstrings, the chrome CSS, and gallery labels. This sweep fixes the visible Agent glitches and codifies the underlying rules so the drift cannot quietly return.

#### Strategy {#strategy}

- Fix the Agent renderer first, on the shared mechanism: count → `resultSummary` badge, status → dot only, fold → chrome chevron only, plus an Agent-only working body for the expanded-while-running window.
- Keep global [D02] intact — the dot stays the sole *status* signal. The working body is calm, non-animated *content* (not a competing in-flight indicator), and only fills the brief zero-nested-calls window; once child calls stream in, the real transcript renders.
- Generalize by **removing** the drifts (extra fold, status text), not by adding machinery — the chrome is already the consistency layer.
- Normalize the remaining status-text outliers (`cron`, `task-mgmt`, `notebook-edit`) onto the rule: lifecycle → dot; compact tokens → `resultSummary` badge; sentence-shaped results → body, honestly labeled (not "status").
- Sweep the dead `StreamingPlaceholder` documentation to state the real behavior, and record the three rules as lightweight conventions — not tuglaws (they are implementation facts, not locked-in project law).
- Each step is independently committable with a falsifiable checkpoint; pure helpers get unit cases, behavior is verified via `just app-test` and the gallery.

#### Success Criteria (Measurable) {#success-criteria}

- An in-flight Agent block shows its task `description` in the header detail and a blue pulsing dot, with no status text in the detail column. (visual + gallery)
- Expanding a still-running Agent block shows calm working content, never a 1px-empty body; once nested calls arrive they render live. (`just app-test`, gallery streaming state)
- A completed Agent block shows an `N calls` badge in the trailing badge slot — visible **both collapsed and expanded** — and no green `Completed` text. (visual + `agentNestedCallCount` unit test)
- Every tool block shows exactly one fold control: the chrome chevron when the block is collapsible (`foldSuppressed`), otherwise the body kind's own cue — never both. A top-level Agent shows a single fold; a nested Agent (no chrome chevron) still has its inner fold. (`just app-test` 2-level agent)
- No `--tugx-agent-status-*` token or `[data-agent-status=...]` color rule remains. (grep checkpoint)
- `cron`, `task-mgmt`, and `notebook-edit` no longer render lifecycle text in a body `status` field row. (unit tests + grep)
- `grep -rn StreamingPlaceholder src/` returns zero matches. (grep checkpoint)
- `bun run check`, `bun test`, `just lint`, and `just app-test` all pass. (commands)

#### Scope {#scope}

1. `TaskToolBlock`: drop status text, surface `description` as header detail, derive and pass the nested-call count as a `resultSummary` count badge.
2. `AgentTranscriptBlock`: gate the nested-calls fold cue + portal on `!foldSuppressed` (chrome owns the fold at top level; nested keeps its own); keep `useBlockFoldState` and the [D17] cap; remove standalone-header status text; delete `--tugx-agent-status-*` tokens/rules.
3. New `AgentWorkingBody` component (Agent-only) wired into `TaskToolBlock`'s streaming body.
4. Normalize `cron` + `task-mgmt` result/status field rows onto the badge slot / honest body labeling.
5. Normalize `notebook-edit` delete-mode confirmation onto a `resultSummary` text badge.
6. Documentation sweep: retire all `StreamingPlaceholder` references; add a brief conventions note to `design-decisions.md`.
7. Add a `gallery-task-tool-block` demonstrating the working / completed-with-count / nested states; update touched gallery labels.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Reversing [D02] / building a generic cross-tool streaming placeholder. The working body is **Agent-only**; every other tool keeps `body = null` while streaming.
- Any new tuglaws. The three rules stay as code-review conventions (light note in `design-decisions.md` at most).
- Reworking the chrome's layout, the dot/`TugProgressIndicator`, or the `ToolResultSummary` type itself (the existing `count`/`text` kinds suffice).
- Touching the reducer / `childToolCallsByParent` wiring or subagent recursion ([D17]) — render-only changes.
- Markdown rendering of agent text entries (the pre-existing prose path is untouched).

#### Dependencies / Prerequisites {#dependencies}

- None external. All work is within `tugdeck/src/components/tugways/`. HMR is live; no build step needed for the dev loop.

#### Constraints {#constraints}

- Tugdeck laws: [L02] external state via `useSyncExternalStore`; [L06] appearance via CSS/DOM, never React state; [L19] `.tsx`+`.css` pair + exported props + module docstring + `data-slot`; [L20] component-token sovereignty; [L23] collapse survives reload via the [A9] axis.
- Global [D02] (dot is the only in-flight signal) and [D05] (two-layer chrome/body split) hold; cite, do not reopen.
- WARNINGS ARE ERRORS for Rust, but this is frontend; `just lint` + `bun run check` must stay clean.
- Per project policy, no mock-store or fake-DOM render tests — unit-test pure helpers, verify behavior with `just app-test` + gallery.

#### Assumptions {#assumptions}

- The Agent `description` is present on the input fragment early enough to surface at kickoff (it is narrowed today but "not surfaced"); when absent, the header falls back to the agent type, as it does now.
- `AgentTranscriptBlock` standalone (non-embedded) mode is exercised only by the gallery; the transcript view always composes it `embedded` via `TaskToolBlock`. Removing the embedded inner-collapse is therefore safe; standalone keeps its own header for the gallery.
- The nested-call count equals `childToolCalls.length` while running and `structured.totalToolUseCount` once the structured result lands; coalescing to the larger known value is correct for the collapsed badge.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `**References:**` lines. Plan-local decisions are `[P01]`+ (never `[D##]`, reserved for global `design-decisions.md`, which this plan cites by reference).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] What does the Agent working body display? (DECIDED) {#q01-working-body-content}

**Question:** Beyond "not empty," what content does the working body show in the zero-nested-calls window?

**Why it matters:** Too much (animation, a spinner) reopens [D02]; too little reproduces the 1px-empty feel.

**Options (if known):**
- Calm single line ("Working…" / agent-type echo), no animation.
- Echo the task `description` / prompt preview.
- A skeleton/shimmer (rejected — competes with the dot, violates [D02]).

**Plan to resolve:** Decided in-thread with the user.

**Resolution:** DECIDED (see [P04]) — a calm, non-animated single line. The `description` already rides the *header* ([P05]), so the body stays a quiet "working" cue, not a second copy of the description. No shimmer.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Suppressing the inner fold regresses nested-agent collapse / [D17] cap | med | low | Gate the cue on `!foldSuppressed`, keep `useBlockFoldState`; nested keeps its fold + depth cap; verify a 2-level agent in app-test | app-test 2-level agent fails to collapse |
| Working body reads as a status signal, violating [D02] | med | low | Calm static line, no motion; review against [D02] in gallery | reviewer flags it as a spinner |
| `cron`/`task-mgmt` "status" text is genuine domain data, not lifecycle | med | med | Keep the result in the body, relabel off "status"; do not delete data or force a sentence into a badge | a normalized block loses information |

**Risk R01: Suppressing the inner fold regresses nested-agent collapse** {#r01-collapse-removal}

- **Risk:** Nested Agents get no chrome chevron (`ToolBlockHistoryCollapse` is top-level only); their inner fold cue is the sole collapse and the [D17] depth cap. Over-aggressively removing the inner fold would strand nested transcripts permanently expanded.
- **Mitigation:** Gate the cue on `!foldSuppressed` rather than removing it — `useBlockFoldState` stays. Top-level (suppressed) → chrome chevron is the single fold; nested (not suppressed) → inner cue + [D17] default-collapse retained. Verify both in app-test, plus a Maker ▸ Reload expansion-restore.
- **Residual risk:** Top-level and nested compositions now differ in *which* control folds — intended and matches the chrome contract.

**Risk R02: Status-vs-data conflation in normalization** {#r02-status-data}

- **Risk:** `cron`/`task-mgmt` label their result text "status"; misreading it as lifecycle would delete real output.
- **Mitigation:** [P06] keeps the result content (short → badge, long → body) and only stops *labeling it "status"* and stops styling it as lifecycle; the dot carries lifecycle.
- **Residual risk:** Edge results that are neither short nor obviously domain data may look plain — acceptable; the body still shows them.

---

### Design Decisions {#design-decisions}

#### [P01] Nested-call count rides the chrome's `resultSummary` badge (DECIDED) {#p01-count-badge}

**Decision:** `TaskToolBlock` computes the nested-call count and passes `{ kind: "count", count, noun: "call" }` to `ToolBlockChrome.resultSummary`, rendering an `N calls` badge in the trailing slot — the direct analog of `Read`'s `936 lines`.

**Rationale:**
- The badge slot is wrapper-level data, present in both collapsed and expanded states — fixing the "count only appears on expand" glitch.
- Matches every conforming tool; one mechanism, one look.

**Implications:**
- Count derivation becomes a pure, unit-tested helper (`agentNestedCallCount`).
- The old `composeNestedCallsLabel` fold-cue label is deleted with the fold ([P03]).

#### [P02] Lifecycle status is the dot's alone (DECIDED) {#p02-status-dot}

**Decision:** No tool renders lifecycle status (`completed`/`running`/`failed`/`deleted`) as text in the header detail column or a body field row; the lifecycle dot is the sole status signal. Follows global [D02].

**Rationale:**
- `Read` never prints "Completed"; the green dot says it. Agent should match.
- Removes bespoke per-tool status text and its color CSS.

**Implications:**
- `TaskToolBlock` drops the status `<span>`; `task-tool-block.css` and `agent-transcript-block.css` lose their `--tugx-agent-status-*` tokens and `[data-agent-status]` color rules.

#### [P03] One fold per block — the chrome's when collapsible, else the body kind's (DECIDED) {#p03-single-fold}

**Decision:** A tool block shows exactly one fold control. When the chrome is collapsible (history-collapse-wrapped, signalled by `BlockFoldSuppressedContext === true`), the chrome chevron owns the fold and the body kind suppresses its own. When there is no chrome chevron (a nested tool dispatched at `depth+1`, which is *not* history-collapse-wrapped), the body kind keeps its fold cue as the sole control.

**Rationale:**
- The Agent nested-calls `BlockFoldCue` duplicated the chrome chevron **at the top level**, and was invisible until expanded — the actual glitch.
- But `ToolBlockHistoryCollapse` is applied only to top-level blocks (`dev-card-transcript.tsx`); a nested Agent gets `disclosure === undefined` → no chrome chevron, so its inner fold is the *only* fold and `shouldCollapseAgentDepth` is the only [D17] depth-cap safety. Removing the inner fold outright would make nested transcripts permanently un-collapsible and melt deep nesting.
- The chrome already exposes the signal: it wraps children in `BlockFoldSuppressedContext.Provider value={blockCollapse !== null}`, and `useBlockFoldState` already forces `collapsed = false` under suppression. So entries already render open at top level with no change; the only change is the *visibility* of the cue.

**Implications:**
- `AgentTranscriptBlock` reads `BlockFoldSuppressedContext` and renders `nestedFoldCue` / `portaledActions` **only when `!foldSuppressed`**. It **keeps** `useBlockFoldState` (needed for the nested case and the [D17] default-collapse). Top-level: cue suppressed, chrome chevron is the single fold. Nested: cue retained.
- This is also the general rule for any future fold-bearing body kind under the chrome — honor `foldSuppressed`, don't delete the fold.

#### [P04] Agent gets a dedicated, Agent-only working body (DECIDED) {#p04-agent-working-body}

**Decision:** A new `AgentWorkingBody` component renders calm, non-animated working content when an Agent block is streaming with no nested calls yet. No generic cross-tool placeholder; every other tool keeps `body = null` while streaming.

**Rationale:**
- The Agent block lives in a long working state and is the one users expand mid-run; the empty body produced the 1px shift.
- Scoping it to Agent honors [D02] for the fast tools while solving the real pain.

**Implications:**
- New `agent-working-body.tsx` + `.css` pair ([L19]). Wired into `TaskToolBlock`'s `status === "streaming"` branch; once `childToolCalls` exist, the live transcript renders instead.

#### [P05] Surface the agent `description` as the header detail (DECIDED) {#p05-agent-description}

**Decision:** `TaskToolBlock` passes the narrowed `description` as the chrome `identity` (the header detail), available from the input fragment at kickoff; falls back to the agent type when absent.

**Rationale:**
- Directly fixes "no details whatsoever when they first kick off" — the collapsed row now says what the agent is doing.

**Implications:**
- `narrowAgentInput` already extracts `description`; only the wrapper's `identity` wiring changes.

#### [P06] Normalize misplaced status/result text (DECIDED) {#p06-normalize-status}

**Decision:** `cron`, `task-mgmt`, and `notebook-edit` stop rendering lifecycle text in body `status` field rows. The `resultSummary` text badge is reserved for **compact, badge-shaped tokens** (one or two words); sentence-shaped domain results stay in the body under an honest label. Lifecycle is the dot's.

**Rationale:**
- Brings the last text-status outliers onto the rule established by [P01]/[P02].
- The badge slot is sized for tokens like `936 lines`, `exit 0`, `committed`. A cron result such as `Created cron job #3 (every 5m)` is a sentence — forcing it into a tinted badge looks wrong and risks blowing out the header row. Domain data stays in the body; only the misleading `status` label and lifecycle styling go.

**Implications:**
- `notebook-edit` delete-mode: drop the `status: deleted` field row; pass `{ kind: "text", text: "deleted" }` to `resultSummary` (`"deleted"` is a compact token — badge-shaped).
- `cron`/`task-mgmt`: **keep** the result in the body (single-line and multi-line both), relabel the field row off `"status"` (e.g. `result`); do **not** move it to a header badge. Lifecycle is carried by the dot.

#### [P07] Retire `StreamingPlaceholder` in docs; conventions over laws (DECIDED) {#p07-doc-sweep}

**Decision:** Remove all `StreamingPlaceholder` references (docstrings, chrome CSS comment, gallery labels) and replace with the real behavior. Record [P01]–[P03] as a brief conventions note in `tuglaws/design-decisions.md` — not as tuglaws.

**Rationale:**
- The component was never built and [D02] retired the idea; the docs lie uniformly.
- Per the owner, tuglaws are for locked-in essential project law, not implementation facts — go light.

**Implications:**
- ~18 wrapper docstrings, `tool-block-chrome.tsx`/`.css`, and ~8 gallery labels updated to "body is `null` while streaming; the dot carries in-flight."

---

### Specification {#specification}

#### Terminology and Naming {#terminology}

- **Badge slot** — the chrome's single trailing `resultSummary` element rendered as a `TugBadge`.
- **Lifecycle dot** — `TugProgressIndicator` in `pulsing-dot` variant; the sole status signal ([D02]).
- **Working body** — Agent-only calm content shown while streaming with no nested calls yet ([P04]).
- **Drift** — a renderer bypassing the chrome's badge/dot/chevron mechanism.

#### Semantics — Agent block states {#agent-states}

- **Kicking off (streaming, no children):** dot pulses blue; header detail shows `description` (or agent type); body = `AgentWorkingBody`; no badge yet.
- **Running (streaming, children arriving):** dot blue; body = live `AgentTranscriptBlock` rendering nested calls; badge = `N calls` from `childToolCalls.length`.
- **Completed (ready):** dot green; badge = `N calls` (`totalToolUseCount`); body = full transcript; no status text.
- **Error:** dot red; chrome error band from `textOutput`; no body.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Nested-call count badge | local-data (derived) | `useMemo` over `childToolCalls`/`structured`; no persisted state | [L06] |
| Header detail (`description`) | appearance/data via props | passed as chrome `identity`; pure render | [L06] |
| Working-body visibility | structure (which rows exist) | conditional render keyed on `transcriptData` entry count; no new state | [L06] |
| Agent expansion — top-level (embedded, `foldSuppressed`) | structure | chrome whole-block collapse via [A9] mount/unmount; inner cue suppressed, inner state forced open | [L23], [L06] |
| Agent expansion — nested (no chrome chevron) | structure | inner `useBlockFoldState` retained ([D17] default-collapse), persisted via [A9] | [L23], [L06] |
| Status text + status colors | — | **removed** (dot carries status) | [L06], [L20] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pin pure helpers (count derivation, summary composition) | New/changed `compose*`/derive helpers |
| **Integration (app-test)** | Drive the real app to verify rendered states | Kickoff/running/completed Agent states, reload-restore |
| **Drift Prevention (grep)** | Assert the rules hold | No second `BlockFoldCue`, no `--tugx-agent-status-*`, no `StreamingPlaceholder` |

#### What stays out of tests {#test-non-goals}

- Fake-DOM render assertions and mock-store tests — banned by project policy; behavior is verified via `just app-test` and the gallery.
- Snapshotting the chrome markup — brittle; the badge/dot/fold rules are checked by targeted grep + unit helpers.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. References cite plan artifacts and anchors, never line numbers.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Agent header: drop status, surface description, add count badge | done | d485db3d |
| #step-2 | Suppress the duplicate fold under the chrome + remove status text | done | 4f714de5 |
| #step-3 | Add the Agent-only working body | done | 9bb95bb4 |
| #step-4 | Normalize cron + task-mgmt status labels | done | 1761e570 |
| #step-5 | Normalize notebook-edit delete confirmation | done | 5ae7d071 |
| #step-6 | Retire StreamingPlaceholder docs + conventions note | done | 7f562780 |
| #step-7 | Add gallery-task-tool-block | done | c5b011c0 |
| #step-8 | Integration checkpoint | done | b82e4263 |

#### Step 1: Agent header — drop status, surface description, add count badge {#step-1}

**Commit:** `tugdeck: agent header rides the chrome badge slot (count) + description detail`

**References:** [P01] count badge, [P02] status-dot, [P05] description detail, [D02], [D05], Spec (#agent-states), (#strategy)

**Artifacts:**
- `task-tool-block.tsx`: remove the `runStatus` span from `argsSummary`; pass `identity={description ?? agentType}`; add `agentNestedCallCount(...)` pure helper and pass `resultSummary={{ kind: "count", count, noun: "call" }}` when count > 0.
- `task-tool-block.css`: remove the `.task-tool-block-status[...]` color rules and any status references.

**Tasks:**
- [ ] Add `agentNestedCallCount(childToolCalls, structured)` — `max(childToolCalls?.length ?? 0, structured.totalToolUseCount ?? 0)`.
- [ ] Wire `identity` to the narrowed `description`, falling back to agent type; keep the agent-type `<code>` as today.
- [ ] Pass `resultSummary` count when count > 0; omit otherwise.
- [ ] Delete the status `<span>` and its CSS.

**Tests:**
- [ ] `task-tool-block.test.ts`: `agentNestedCallCount` — running (children only), completed (`totalToolUseCount`), coalescing, zero.

**Checkpoint:**
- [ ] `bun test src/components/tugways/cards/tool-blocks/__tests__/task-tool-block.test.ts`
- [ ] `bun run check`

#### Step 2: Suppress the duplicate fold under the chrome + remove status text {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck: agent transcript honors foldSuppressed (single fold) + drops status text`

**References:** [P02] status-dot, [P03] single-fold, [D17], [L06], [L20], [L23], Risk R01, (#r01-collapse-removal)

**Artifacts:**
- `agent-transcript-block.tsx`: read `BlockFoldSuppressedContext`; render `nestedFoldCue` / `portaledActions` only when `!foldSuppressed` (top-level under a collapsible chrome → suppressed; nested with no chrome chevron → kept). **Keep** `useBlockFoldState` (it already forces `collapsed = false` under suppression and supplies the [D17] default-collapse for the nested case). Remove the standalone-header status `<span>` and `composeNestedCallsLabel` only if it has no remaining caller (it backs the cue, which still renders in the nested case — so retain it).
- `agent-transcript-block.css`: remove `--tugx-agent-status-*` tokens and `.tugx-agent-status[data-agent-status]` color rules.

**Tasks:**
- [ ] Gate `nestedFoldCue` + `portaledActions` on `!foldSuppressed`; leave entries gating to `useBlockFoldState` (unchanged).
- [ ] Remove the standalone-header status `<span>`.
- [ ] Delete the status tokens/rules from the CSS.
- [ ] Confirm `composeNestedCallsLabel` still has a caller (the nested cue); keep it and its test if so.

**Tests:**
- [ ] `agent-transcript-block.test.ts`: keep `countNestedToolCalls` / `composeAgentTranscriptData` / `composeNestedCallsLabel` (nested cue still uses it); add a `shouldCollapseAgentDepth` case asserting the [D17] cap survives.

**Checkpoint:**
- [ ] `grep -rn "tugx-agent-status-" src/` returns nothing.
- [ ] `bun test src/components/tugways/body-kinds/__tests__/agent-transcript-block.test.ts && bun run check`
- [ ] `just app-test`: a top-level Agent shows a single fold (chrome chevron, no inner cue); a 2-level (nested) Agent still exposes its inner fold and a depth-capped nested agent starts collapsed.

#### Step 3: Add the Agent-only working body {#step-3}

**Depends on:** #step-1

**Commit:** `tugdeck: agent working body for the streaming, no-nested-calls window`

**References:** [P04] agent-working-body, [Q01] (#q01-working-body-content), [D02], [L19], Spec (#agent-states)

**Artifacts:**
- New `agent-working-body.tsx` + `agent-working-body.css` — calm, non-animated single-line working cue; `data-slot="agent-working-body"`; docstring; exported props.
- `task-tool-block.tsx`: render `AgentWorkingBody` when `transcriptData` has **zero entries**; otherwise render the live `AgentTranscriptBlock`. Keyed on entry count, not `status` — so a streaming Agent with children already renders live calls and the placeholder never flashes over real content. (`transcriptData` is already computed via `useMemo` regardless of status and folds in `childToolCalls`.)

**Tasks:**
- [ ] Author the component pair per [L19]; no motion, reuse existing block text tokens (no new status tokens).
- [ ] Replace the streaming `body = null` with the entry-count branch (zero entries → working body; else transcript).

**Tests:**
- [ ] `task-tool-block.test.ts`: a pure guard helper for "show working body" — zero entries → true; ≥1 entry → false (streaming-with-children and ready-with-content both render the transcript).

**Checkpoint:**
- [ ] `bun run check && just lint`
- [ ] `just app-test` — kick off an Agent, expand it before tools run: calm working body, no 1px collapse; once calls arrive the transcript replaces it.

#### Step 4: Normalize cron + task-mgmt status labels {#step-4}

**Commit:** `tugdeck: cron + task-mgmt relabel result body row off "status" (dot carries lifecycle)`

**References:** [P06] normalize-status, [P02] status-dot, Risk R02, (#r02-status-data)

**Artifacts:**
- `cron-tool-block.tsx`, `task-mgmt-tool-block.tsx`: keep the result in the body (single-line and multi-line); relabel the field row from `status` to an honest `result`/`output`. Do **not** move it to a header badge (results are sentence-shaped — [P06]/F3). Lifecycle is the dot's.

**Tasks:**
- [ ] Relabel the result field row(s) off `"status"`; keep id field rows and the body content.

**Tests:**
- [ ] `cron-tool-block.test.ts`, `task-mgmt-tool-block.test.ts`: assert the body composes the result under the new label (existing pure-helper surface).

**Checkpoint:**
- [ ] `bun test src/components/tugways/cards/tool-blocks/__tests__/cron-tool-block.test.ts src/components/tugways/cards/tool-blocks/__tests__/task-mgmt-tool-block.test.ts`
- [ ] `grep -rn 'label="status"' src/components/tugways/cards/tool-blocks` returns nothing.

#### Step 5: Normalize notebook-edit delete confirmation {#step-5}

**Commit:** `tugdeck: notebook-edit delete reports "deleted" via the badge slot`

**References:** [P06] normalize-status, [P02] status-dot

**Artifacts:**
- `notebook-edit-tool-block.tsx`: delete mode → `resultSummary={{ kind: "text", text: "deleted" }}`, body = `null` (no `status: deleted` field row).

**Tasks:**
- [ ] Replace the delete-mode body field row with the text badge.

**Tests:**
- [ ] `notebook-edit-tool-block.test.ts`: delete mode composes a `text` summary; body is null.

**Checkpoint:**
- [ ] `bun test src/components/tugways/cards/tool-blocks/__tests__/notebook-edit-tool-block.test.ts && bun run check`

#### Step 6: Retire StreamingPlaceholder docs + conventions note {#step-6}

**Commit:** `tugdeck: retire StreamingPlaceholder references; note the tool-block consistency rules`

**References:** [P07] doc-sweep, [P01], [P02], [P03], [D02]

**Artifacts:**
- All wrapper docstrings, `tool-block-chrome.tsx` docstring + `tool-block-chrome.css` comment, and gallery labels mentioning `StreamingPlaceholder` → rewrite to "body is `null` while streaming; the dot carries in-flight."
- `tuglaws/design-decisions.md`: a brief note (not a law) recording status→dot, data→badge, fold→chrome chevron.

**Tasks:**
- [ ] Sweep every `StreamingPlaceholder` mention (see #context count).
- [ ] Add the short conventions note.

**Tests:**
- [ ] None (docs/comments).

**Checkpoint:**
- [ ] `grep -rn "StreamingPlaceholder" src/ tuglaws/` returns nothing.

#### Step 7: Add gallery-task-tool-block {#step-7}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `tugdeck: gallery for the agent tool block (working / completed / nested states)`

**References:** [P04] agent-working-body, [P01] count-badge, Spec (#agent-states)

**Artifacts:**
- New `gallery-task-tool-block.tsx` demonstrating: kicking-off (working body), running (live nested calls + `N calls` badge), completed, error. Register in the gallery index alongside peers.

**Tasks:**
- [ ] Author the gallery with the four states; reuse the catalog fixture shape used by neighboring galleries.

**Tests:**
- [ ] Visual via the gallery route.

**Checkpoint:**
- [ ] `bun run check && just lint`
- [ ] Gallery renders all four Agent states correctly.

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [P01]–[P07]

**Tasks:**
- [ ] Confirm every success criterion holds end-to-end.

**Tests:**
- [ ] `just app-test` exercises kickoff/running/completed Agent states and a Maker ▸ Reload expansion-restore (Risk R01).

**Checkpoint:**
- [ ] `bun run check && bun test && just lint && just app-test` all green.
- [ ] Grep guards from #step-2 and #step-6 still return nothing.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Agent tool block renders on the shared chrome mechanism (count badge, dot-only status, single fold, working body), and the same three rules hold across the tool-block subsystem.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Agent block: description detail at kickoff, blue dot, no status text. (visual/gallery)
- [ ] Agent block: `N calls` badge in the trailing slot, collapsed and expanded. (unit + visual)
- [ ] Expanding a running Agent shows calm working content, then live nested calls; no 1px collapse. (`just app-test`)
- [ ] One fold per block — single fold on a top-level Agent, inner fold retained on a nested Agent. (app-test)
- [ ] No `--tugx-agent-status-*`; no `StreamingPlaceholder`; no `label="status"` rows. (grep)
- [ ] `bun run check && bun test && just lint && just app-test` green.

**Acceptance tests:**
- [ ] Unit: `agentNestedCallCount`, notebook-edit/cron/task-mgmt summary mapping.
- [ ] app-test: Agent kickoff → running → completed, plus reload-restore.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Route Agent text entries through the assistant-text/markdown renderer once it ships.
- [ ] Consider a richer working body (live token/duration ticker) if [D02] is ever revisited.

| Checkpoint | Verification |
|------------|--------------|
| Agent on the shared mechanism | gallery + app-test across states |
| Rules hold subsystem-wide | grep guards (fold, status tokens, StreamingPlaceholder, status labels) |
| Green gate | `bun run check && bun test && just lint && just app-test` |
