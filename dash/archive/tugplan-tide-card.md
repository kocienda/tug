<!-- tugplan-skeleton v2 -->

## T3.4.c — Tide Card (functional registration) {#tide-card}

**Purpose:** Ship the Tide card — the Unified Command Surface — as a registered, functional card that drives a real `CodeSessionStore` against a live tugcast/Claude session. This is the first phase where opening a card in tugdeck means *talking to Claude in a project of your choice*.

The card body is **not** built from the original [tide.md §T3.4.c](./tide.md#t3-4-c-tide-card) snippet. It is built by **copying `tugdeck/src/components/tugways/cards/gallery-prompt-entry.tsx` verbatim** and swapping the mock seams for real backend services. Everything the gallery card has accumulated in the polish pass — maximize toggle with persistence, editor settings popover (Font / Size / Tracking / Leading), atom font embedding, route gutter with `>`/`❯` alias, content-driven sizing gated on maximize, status row layout with the toggle next to the gear — ships intact.

This plan also rides with [T3.0.W3.b](./tide.md#t3-workspace-registry-w3b): bootstrap workspace removal lands in the same commit because the picker's `spawn_session` path replaces it as the source of workspace frames.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-04-19 |
| Roadmap anchor | [tide.md §T3.4.c](./tide.md#t3-4-c-tide-card) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The original tide.md §T3.4.c text was written before T3.4.b's polish pass. Since [T3.4.b](./tide.md#t3-4-b-prompt-entry) landed `TugPromptEntry`, two gallery cards (`gallery-prompt-entry`, `gallery-prompt-entry-sandbox`) have served as the working surface for everything that arrived after the original spec was authored:

- **Maximize toggle.** `TugPromptEntry` exposes controlled `maximized` + `onMaximizeChange` props (commits `01308ce2`, `29127a77`). The gallery card pegs the panel to `maxSize` via `TugSplitPanelHandle.setTransientSize`, disables the split-pane drag while maximized, and persists the state across reload via `useTugcardPersistence`.
- **Maximize size-writer gating.** The two other writers to panel size — `useContentDrivenPanelSize` and `handleBeforeSubmit`'s animated restore — both stand down while `maximized === true` (commit `d12429ca`). When `maximized === false`, the pane behaves identically to pre-toggle.
- **Editor settings popover.** Tracking + Leading controls were added (commit `02bf55e4`) alongside Font + Size, all four with `topLabel` captions (commit `02bf55e4`'s `tug-popup-button` extension). Backed by `EditorSettingsStore` with `letterSpacing` and `lineHeight` persisted to tugbank.
- **Per-icon-button glyph sizing.** `tug-button.css` gained per-size SVG rules so the maximize and gear icons actually scale with the button's `size` prop (commit `01308ce2`).
- **Atom rendering.** Atoms now embed `@font-face` fonts via `tug-atom-fonts.ts` (commit `7cefe36f`) so labels render in the editor's actual font instead of falling back to generic Courier. Atom label size is `0.96 × editor size` to compensate for SVG vs HTML rasterization differences (commit `254e53dd`). Atom baseline aligns with the surrounding text baseline (commit `a047adff`). Clipboard paste sanitizes WebKit-injected inline styles (commit `992b58c9`).
- **Route prefix in a gutter.** Route atoms were retired entirely (commit `7cefe36f`'s purge); the route is now rendered as text in a separate gutter element. Both `>` (ASCII) and `❯` (chevron) flip the route to Prompt (commit `57a25e47`).

The result: `gallery-prompt-entry.tsx` is the canonical, polished, accessible-feature-complete shape of "a `TugPromptEntry` in a card body". Re-deriving any of this in a fresh `tide-card.tsx` would silently lose features and waste days re-debugging visual edge cases.

What's missing for production: real `CodeSessionStore` against the wire (not `MockTugConnection`), real `SessionMetadataStore` and `PromptHistoryStore` singletons, a `project_dir` picker at card mount, `spawn_session` / `close_session` lifecycle wiring, card registration, and a `lastError` affordance per [tide.md §T3.4.a `lastError`](./tide.md#code-session-store) line 2513.

This plan also lands [T3.0.W3.b](./tide.md#t3-workspace-registry-w3b) — deletion of the bootstrap workspace and the `--source-tree` CLI flag — in the same commit. The bootstrap exists today purely so the existing git/filetree cards have *something* to subscribe to. Once the Tide card's picker drives `spawn_session` for any chosen project, the bootstrap has no remaining job, and removing it in the same commit keeps the transition atomic (no intermediate commit has both "bootstrap gone" and "no UI picker yet").

#### Strategy {#strategy}

- **Copy gallery-prompt-entry wholesale.** The first commit on this plan is `cp tugdeck/src/components/tugways/cards/gallery-prompt-entry.{tsx,css} tugdeck/src/components/tugways/cards/tide-card.{tsx,css}` followed by a rename of the React component (`GalleryPromptEntry` → `TideCardContent`) and the props interface. Nothing else changes in that commit. It builds, it renders, it just isn't registered yet. Every subsequent step replaces a single mock seam or wires one piece of new behavior, with a green build at every commit.
- **Substitution table is the contract.** The work is not "rewrite around real services"; it is to swap a finite, enumerated list of seams. Anything not on the substitution table carries over verbatim from the gallery copy.
- **Project picker is genuinely new.** No existing tugdeck card has a project-path-picker affordance. The minimum viable picker is a single text input + button ("Open project") that takes a path string, validates it exists locally, and calls `spawn_session(cardId, tugSessionId, projectDir)`. File-picker UX (native dialog or drag-drop) is a polish item for T3.4.d.
- **Spawn lifecycle owns the card mount.** On mount, the card encodes `spawn_session(cardId, tugSessionId, projectDir)`, awaits `spawn_session_ok`, calls `cardSessionBindingStore.setBinding(...)`, then constructs the `CodeSessionStore`. On unmount, it calls `sendCloseSession(...)`. The store does NOT send `close_session` itself per [tide.md line 2391](./tide.md#code-session-store). All of this plumbing — `encodeSpawnSession`, `cardSessionBindingStore`, `sendCloseSession` — already exists from W2 Step 7.
- **Every card gets its own fresh session.** Opening a second (or third) Tide card does not share or resume a prior session — each card's tugcode spawns claude fresh on mount, so concurrent cards can't collide on `--resume`. The pre-P2 "single-session shim" originally planned as [4l](#step-4l) was dropped in favor of this simpler default ([4k](#step-4k)); see 4l's tombstone for the decision trail. The resume-as-a-user-choice UX is scoped as [Step 4.5](#step-4-5), not as a pre-emptive picker disable.
- **lastError affordance lands here.** Per tide.md line 2513, the `errored` UI affordance was deferred from T3.4.a to T3.4.c. Surface `lastError` in the card body — either as a banner above the entry, an inline message, or a status-row badge. Decide in Step 6.
- **W3.b (bootstrap removal) rides in the same commit.** Per [tide.md §T3.0.W3.b](./tide.md#t3-workspace-registry-w3b), removing `--source-tree`, the `registry.get_or_create(&watch_dir, cancel.clone())` bootstrap call, the `server.rs::source_tree` parameter threading, and the `bootstrap.fs_watch_rx` plumbing happens *with* the card landing, not before or after. Tests that assumed the bootstrap workspace are rewritten to call `spawn_session` explicitly, or deleted if the card-mount tests cover the same surface.
- **Manual A/B smoke from W2 Step 8 becomes the closing acceptance test.** [tide.md execution order line 697](./tide.md#execution-order-w2-to-tide) defers the W2 manual smoke to T3.4.c specifically because the card was the missing UI affordance. Closing the plan means: open a Tide card pointed at project A, open a second pointed at project B (no shim gates this, per [4k](#step-4k)/[4l](#step-4l)), verify distinct `workspace_key` filters end-to-end.
- **Warnings are errors. Tests stay green at every commit.** `bun run check`, `bun run test`, `cargo nextest`, and `bun run audit:tokens lint` all pass on every commit. No `any`, no `@ts-expect-error`, no descendant-selector reach-ins, no IndexedDB. The `gallery-prompt-entry-sandbox` card stays — it remains useful as a synthetic-frame harness even after the Tide card ships.

#### Success Criteria (Measurable) {#success-criteria}

**Card registration & mount:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` and `.css` exist; export `TideCardContent` + `registerTideCard()`. (verification: `tsc --noEmit` clean)
- `tugdeck/src/main.tsx` calls `registerTideCard()` adjacent to `registerGitCard()`. (verification: `rg 'registerTideCard\(\)' tugdeck/src/main.tsx` returns one match)
- Opening a Tide card in the running tugdeck shows: split pane (markdown view top, prompt entry bottom), project-path picker on first mount, all settings-popover controls (Font / Size / Tracking / Leading), maximize toggle, route gutter, project badge after a path is chosen.

**Feature parity with `gallery-prompt-entry` (the baseline contract):**
- Maximize toggle is present, persisted across reload, and disables drag while active. The content sizer and submit-time restore stand down while maximized. (verification: manual; spot-check against gallery card)
- Editor settings popover renders Font / Size / Tracking / Leading with `topLabel` captions; selecting a value updates the editor live and persists to tugbank. (verification: manual)
- Atom labels render in the editor's font (e.g., Hack), not generic monospace. Pasting an atom doesn't introduce styling artifacts. (verification: manual)
- Route gutter shows `❯` for the Prompt route; typing `>` first eats the char and flips the route. (verification: manual + test)
- Content-driven panel sizing grows the bottom panel as the editor overflows and snaps back on `data-empty=true` (when maximize is off). (verification: manual)
- Per-route drafts persist across route switches and across reload. (verification: manual)

**Backend wiring:**
- On mount: `spawn_session(cardId, tugSessionId, projectDir)` is sent; the card waits for `spawn_session_ok` before constructing the `CodeSessionStore`; `cardSessionBindingStore.setBinding(...)` records the binding. (verification: integration test, asserting frame ordering against a mock connection)
- On unmount: `sendCloseSession(...)` is sent; binding is cleared. (verification: integration test)
- The card subscribes to `[CODE_INPUT, CODE_OUTPUT, SESSION_METADATA, FILETREE]` via the registry's `defaultFeedIds`. (verification: registration assertion)
- Submitting `> hello` round-trips through real Claude: `user_message` on `CODE_INPUT` → `assistant_text` deltas on `CODE_OUTPUT` → `TugMarkdownView` renders streaming text → `turn_complete(success)` returns the entry to idle. (verification: manual smoke against a live `tugcast` + `claude` build)

**lastError affordance:**
- When the store's `lastError` is non-null, the card surfaces it visibly (banner / inline / badge — pick one in Step 6). Successful submit clears it per the existing store semantics. (verification: manual + test)

**W3.b coupling:**
- `--source-tree` flag deleted from `tugcast` CLI. `registry.get_or_create(&watch_dir, cancel.clone())` bootstrap call removed. `server.rs::source_tree` parameter threading dropped. `bootstrap.fs_watch_rx` plumbing unwired. (verification: `rg --source-tree tugrust/` returns zero matches; `cargo nextest` green)
- Pre-existing integration tests that assumed the bootstrap workspace are rewritten to call `spawn_session` explicitly, or deleted. (verification: cargo nextest green)
- Daily dev workflow (running tugdeck without flags) still works: opening a Tide card and choosing a project replaces the bootstrap as the source of workspace frames. (verification: manual smoke)

**Concurrent Tide cards:**
- Opening a second (or third) Tide card while a first is bound spawns its own fresh claude session. Each card has its own tugcode subprocess, its own session id, and writes to its own session JSONL. No shim, no picker disable, no "single-session" banner — the pre-P2 shim originally scoped as [4l](#step-4l) was dropped once [4k](#step-4k) made it moot. (verification: manual + test)

**Manual A/B smoke (closes W2 Step 8):**
- Open a Tide card pointed at project A; open a second card pointed at project B. Verify each card's FILETREE / FILESYSTEM / GIT feeds carry only its own workspace's frames. (verification: manual; record a session-trace before commit)

**Repo hygiene:**
- `bun run check` exits 0. `bun run test` exits 0 with all tests passing. `bun run audit:tokens lint` exits 0. `cargo nextest run` exits 0 across the workspace. (verification: each step's exit checkpoint)
- No new IndexedDB references introduced (D-T3-10). (verification: `rg -i 'indexeddb' tugdeck/src/components/tugways/cards/tide-card.*` returns zero matches)
- `gallery-prompt-entry-sandbox` is untouched and still functional. (verification: manual)

**Tuglaws adherence (hard exit criterion):**
- The Tide card and everything it pulls in (`tide-card.tsx`, `useTideCardServices`, the picker, any helpers introduced by this plan) must achieve *full, complete, and unambiguous* adherence to [tuglaws.md](../tuglaws/tuglaws.md) before the plan can close. No copy-in-good-faith exceptions, no "inherited from gallery" excuses — if a pattern in the Tide card violates a law, it must be fixed.
- Laws with known risk in this plan: L02 (external state via `useSyncExternalStore` only), L03 (registrations in `useLayoutEffect`), L06 (appearance via CSS/DOM, not React state), L07 (action handlers access state via refs or stable singletons), L19 (component authoring), L22 (store observers drive DOM writes directly), L23 (user-visible state preserved across internal ops), L24 (state partitioned into appearance / local-data / structure zones).
- Specifically: the "`if (ref.current === null) ref.current = new X()`" render-time lifecycle pattern copied from `gallery-prompt-entry.tsx` is on the cleanup list — it splits construction (render-body) from teardown (`useEffect`) in a way that L03/L24 does not sanction and that StrictMode exposes. Hygiene fix lands in Step 4 (see the lifecycle-hygiene bullet under Step 4's Work).
- Verification: before declaring the plan done, re-read [tuglaws.md](../tuglaws/tuglaws.md) and walk `tide-card.tsx` + the picker + any new helpers law-by-law; every law either applies and is satisfied, or does not apply and is noted as such. Record the walkthrough in [Step 8](#step-8).

#### Scope {#scope}

**In scope:**
- Card body (`tide-card.tsx` / `tide-card.css`), card registration in `main.tsx`.
- `useTideCardServices(cardId)` hook constructing per-card `CodeSessionStore` + `PropertyStore` for streaming, plus shared lazy singletons for `SessionMetadataStore`, `PromptHistoryStore`, `FileTreeStore`.
- Project-path picker — text input + "Open project" button only ([D1](#resolved-decisions)). Picker is the full card body until bound; disappears when bound; no in-card re-bind ([D3](#resolved-decisions), [D4](#resolved-decisions)).
- Recent-projects quick-pick (last ≈5 paths persisted in tugbank, rendered as buttons under the picker input) — soft requirement, ship if time permits ([D2](#resolved-decisions)).
- `spawn_session` / `close_session` lifecycle wiring at card mount/unmount, including `cardSessionBindingStore.setBinding` / `clearBinding`.
- `TugMarkdownView` binding to `services.codeSessionStore.streamingStore` / `streamingPath` for the top pane.
- `lastError` UI affordance.
- ~~Single-session mode shim pre-P2~~ — dropped in favor of fresh-per-card spawn ([4k](#step-4k)); decision trail in [4l](#step-4l).
- Bootstrap removal (W3.b) — `--source-tree` deletion, registry bootstrap call deletion, server.rs threading deletion, related test cleanup.
- Manual A/B smoke as the closing acceptance test.

**Out of scope (deferred):**
- Native file-picker dialog or "Browse…" affordance for project paths — text input only per [D1](#resolved-decisions); native picker is T3.4.d polish.
- In-card re-bind to a different `project_dir` — opening a new card is the gesture per [D4](#resolved-decisions).
- Multi-session via P2 — T3.4.c ships with fresh-per-card spawn ([4k](#step-4k)), which sidesteps the pre-P2 single-session constraint the original shim ([4l](#step-4l), dropped) was guarding against.
- Claude `--resume` (P14) — UX informed by T3.4.c, lands separately.
- stream-json version gate (P15) — gates on T3.4.c reducer hardening, lands separately.
- `BuildStatusCollector` per-workspace ([tide.md line 2102](./tide.md#prefix-router-prompt-input)).
- `control_request_forward` (permission/question) UI — lands in T3.4.d per [tide.md §T3.4.d](./tide.md#t3-4-d-polish-exit).

---

### Steps {#steps}

Each step is its own commit. Tests + checks pass at the end of every step.

#### Step 1 — Copy the gallery card verbatim {#step-1}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (new — `cp` of `gallery-prompt-entry.tsx`).
- `tugdeck/src/components/tugways/cards/tide-card.css` (new — `cp` of `gallery-prompt-entry.css`).

**Work:**
- `cp` both files. Rename the exported component (`GalleryPromptEntry` → `TideCardContent`), the props interface (`GalleryPromptEntryProps` → `TideCardContentProps`), the `data-testid` value (`gallery-prompt-entry` → `tide-card`), and the CSS root class (`gallery-prompt-entry-card` → `tide-card`). Update internal class names that referenced the gallery prefix.
- Leave every mock seam (`mockSessionRef`, `getFixtureSessionMetadataStore`, fixture file completion) in place — they're swapped in later steps.
- The card is not registered yet. It builds; `main.tsx` does not call it; nothing renders.

**Verification:**
- `bun x tsc --noEmit` exits 0.
- `bun test` exits 0 (no new tests; existing suite still green).
- `rg 'TideCardContent' tugdeck/src/` returns at least one match in `tide-card.tsx`.

#### Step 2 — Register the card with mock services {#step-2}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (add `registerTideCard()` export).
- `tugdeck/src/main.tsx` (call `registerTideCard()` after `registerGitCard()`).

**Work:**
- Add `registerTideCard()` per the snippet in [tide.md §T3.4.c](./tide.md#t3-4-c-tide-card): `componentId: "tide"`, default meta, `defaultFeedIds: [CODE_INPUT, CODE_OUTPUT, SESSION_METADATA, FILETREE]`, size policy.
- Wire `contentFactory: (cardId) => <TideCardContent cardId={cardId} />`.
- Opening the card from the card menu mounts the copied body inside tugdeck's normal card chrome (title bar, close button, resize handles). The body itself is unchanged from Step 1 — same split pane, same mock-backed entry, same polish features — only the mount path differs from the gallery grid.

**Verification:**
- `bun run check` clean.
- Manual: open the card from the card menu; the body renders with all polish features (maximize toggle, settings popover, route gutter, content-driven sizing, atom fonts).
- `rg 'registerTideCard\(\)' tugdeck/src/main.tsx` returns one match.

#### Step 3 — Extract `useTideCardServices` skeleton (still mock-backed) {#step-3}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (extract the per-card service construction into a hook).

**Work:**
- Extract the existing per-card setup (`mockSessionRef`, `historyStoreRef`, fixture metadata store, completion providers, editor store binding) into a single hook `useTideCardServices(cardId: string)` returning an object: `{ codeSessionStore, sessionMetadataStore, historyStore, completionProviders, editorStore }`.
- The hook's internals still reference the mock layer; only the *shape* is what Step 4 will swap.
- The card component's body shrinks: it calls `useTideCardServices(cardId)` and passes the returned services into the JSX it already had.

**Verification:**
- Same as Step 2; nothing visibly changes.
- Existing tests still pass.

#### Step 4 — Wire real backend services + project picker {#step-4}

This is the largest step in the plan. It replaces every mock seam with live wiring, introduces the project picker, lands the spawn/close lifecycle, enforces single-session discipline pre-P2, fixes the render-body lifecycle smell flagged in Step 3, addresses three tugcode-side issues surfaced during live smoke (test-tugbank isolation, per-workspace session id, process lifecycle), and scrubs every mock / fixture reference out of the production code path. To stay reviewable and bisectable, the work is decomposed into thirteen sub-steps — **one commit per sub-step**. The system builds, typechecks, and tests pass at every commit. Live-Claude manual smoke becomes possible at [4e](#step-4e); before that, each sub-step is validated via unit/integration tests.

Sub-step ordering reflects dependencies:

| Sub-step | What it lands |
|---|---|
| [4a](#step-4a) | Lifecycle hygiene — fix the `if (ref.current === null) ref.current = new X()` pattern |
| [4b](#step-4b) | Subscribe to `cardSessionBindingStore`; services become `TideCardServices | null` |
| [4c](#step-4c) | Project picker + `spawn_session` submission |
| [4d](#step-4d) | `sendCloseSession` on unmount |
| [4e](#step-4e) | Swap `CodeSessionStore` to live connection (first real Claude smoke) |
| [4f](#step-4f) | Swap `SessionMetadataStore` to live per-card |
| [4g](#step-4g) | Swap `PromptHistoryStore` to live (shared, persisted) |
| [4h](#step-4h) | **Isolate the tugcode test suite from the real tugbank** |
| [4i](#step-4i) | **Per-workspace session id in tugcode** (replace the global `dev.tugtool.app / session-id` key) |
| [4j](#step-4j) | **Process lifecycle: kill claude + exit on tugcode stdin-EOF**; reap descendants on Tug.app quit |
| [4k](#step-4k) | **Default every card to a fresh session** (stop silently auto-resuming per workspace) |
| [4l](#step-4l) | ~~Single-session shim pre-P2~~ — **dropped**, superseded by [4k](#step-4k) |
| [4m](#step-4m) | Recent projects + opportunistic cleanup |
| [4n](#step-4n) | **Mock/fixture scrub** — hard exit criterion: zero `Mock*` / fixture references in production code |

##### Sub-step 4a — Lifecycle hygiene in `useTideCardServices` {#step-4a}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (refactor hook internals only).

**Work:**
- Replace every `if (xxxRef.current === null) xxxRef.current = new X()` render-body write with an idiomatic lifecycle: construction runs inside a `useLayoutEffect` (empty deps for now; [4b](#step-4b) replaces the deps with a binding gate); services held in `useState`; cleanup disposes. Structure-zone state behind the mechanisms L24 names, with no render-body side effects.
- Preserve the hook's external return shape (still `TideCardServices`, non-null). The binding gate arrives in [4b](#step-4b) — this sub-step is pure compliance refactor, no behavior change.
- Accept a one-frame window where services are null after mount but before the effect commits: render a transient empty pane (no picker yet; that's [4c](#step-4c)). If the flash is visible in manual test, switch to `useState` lazy initializer (StrictMode double-invokes the initializer; `MockTugConnection` holds no external resources so the orphan is harmless — document the choice in a code comment).
- Drop the `eslint-disable-next-line react-hooks/exhaustive-deps` above `completionProviders`. With refs constructed in the effect rather than render-body, the memo deps are correct.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- `rg 'if \(.+Ref\.current === null\)' tugdeck/src/components/tugways/cards/tide-card.tsx` returns zero matches.
- `rg 'eslint-disable' tugdeck/src/components/tugways/cards/tide-card.tsx` returns zero matches.
- Manual: open a Tide card; all polish features still work (maximize toggle, settings popover Font/Size/Tracking/Leading, route gutter, content-driven sizing).

##### Sub-step 4b — Binding subscription; services gated on binding {#step-4b}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx`.

**Work:**
- In `useTideCardServices`, subscribe to `cardSessionBindingStore` via `useSyncExternalStore`. Derive `binding = snapshot.get(cardId) ?? null`.
- Change the services-construction effect's dep to `[binding?.tugSessionId]`. Construct services only when `binding !== null`; dispose on binding change or card unmount.
- Change the hook return type to `TideCardServices | null`.
- In `TideCardContent`, early-return a placeholder div (`<div className="tide-card-picker-pending" aria-hidden="true" />`, empty) when `services === null`. The actual picker lands in [4c](#step-4c).
- Still mock-backed: the mock `CodeSessionStore` and fixture stores are constructed against `binding.tugSessionId` when a binding appears.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- New unit test: render `<TideCardContent cardId="t1" />` → assert placeholder div; `cardSessionBindingStore.setBinding("t1", {tugSessionId: "s1", workspaceKey: "w1", projectDir: "/x"})` → assert split pane renders; `cardSessionBindingStore.clearBinding("t1")` → assert placeholder returns.
- Manual: open a Tide card → empty placeholder shows (expected; picker in [4c](#step-4c)).

##### Sub-step 4c — Project picker + `spawn_session` submission {#step-4c}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (add inline `<TideProjectPicker />`).
- `tugdeck/src/components/tugways/cards/tide-card.css` (picker styles).

**Work:**
- Add an inline `TideProjectPicker({ cardId })` component in `tide-card.tsx`: single text input (label "Project path"), single "Open project" push button, inside the `tide-card` root flex column so it fills the card body per [D3](#resolved-decisions). Text input + button only — no native dialog, no Browse… per [D1](#resolved-decisions).
- Submit handler: `const tugSessionId = crypto.randomUUID(); getConnection()?.sendFrame(encodeSpawnSession(cardId, tugSessionId, projectDir))`. The existing `spawn_session_ok` handler (`action-dispatch.ts:358–386`) calls `cardSessionBindingStore.setBinding(cardId, …)` on the ack; [4b](#step-4b)'s subscription causes `useTideCardServices` to construct services, which makes the picker disappear and the split pane appear.
- Replace the 4b placeholder div with `<TideProjectPicker cardId={cardId} />` when `services === null`.
- No close-on-unmount yet ([4d](#step-4d)). No recent projects ([4m](#step-4m)). No single-session shim — never will be; [4l](#step-4l) was dropped once [4k](#step-4k) made the shim moot.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- New test: mount card → simulate picker submit with a fake connection that captures `sendFrame` → assert a control frame matching `encodeSpawnSession(cardId, <uuid>, projectDir)` was sent. Then simulate `cardSessionBindingStore.setBinding(...)` → assert split pane renders.
- Manual: open Tide card → picker renders; type `/tmp` → click Open project → `encodeSpawnSession` observed in the `tugcast` logs. (Binding won't complete until live backend is wired in [4e](#step-4e); picker staying on screen is expected for now.)

##### Sub-step 4d — `sendCloseSession` on card unmount {#step-4d}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx`.

**Work:**
- In the services-construction `useLayoutEffect` cleanup, when `binding !== null`, call `sendCloseSession(getConnection(), cardId, binding.tugSessionId)` *before* disposing local services. `sendCloseSession` clears the binding in the store and sends the close frame; local dispose tears down subscriptions.
- Order: `sendCloseSession` → `services.codeSessionStore.dispose()` → feed-store dispose.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- New test: mount card → simulate `setBinding` → unmount → assert `encodeCloseSession(cardId, tugSessionId)` frame sent AND `cardSessionBindingStore.getBinding(cardId) === undefined`.

##### Sub-step 4e — Swap `CodeSessionStore` to live connection {#step-4e}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx`.

**Work:**
- Replace the mock construction (`new MockTugConnection()` + `new CodeSessionStore({ conn: mock as any, tugSessionId: TIDE_TUG_SESSION_ID })`) with `new CodeSessionStore({ conn: getConnection()!, tugSessionId: binding.tugSessionId })`.
- Remove the `MockTugConnection` import. Keep `TIDE_TUG_SESSION_ID` constant for now — removed in [4n](#step-4n) once it is truly unreferenced.
- This is the first sub-step where a live Claude turn can round-trip end-to-end: picker → spawn → bind → real `CodeSessionStore` → submit `> hi` → `assistant_text` deltas arrive.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- Manual smoke: launch `tugcast`, open Tide card, enter a real local project path, click Open project, wait for picker to disappear, submit `> hi`, confirm Claude replies streaming through `assistant_text` deltas. **This is the first real end-to-end Claude round-trip in the plan.**

##### Sub-step 4f — Swap `SessionMetadataStore` to live (per-card) {#step-4f}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx`.

**Work:**
- Inside the services-construction effect, construct `new FeedStore(getConnection(), [FeedId.SESSION_METADATA], undefined, workspaceFilter)` and wrap it in `new SessionMetadataStore(...)`. Dispose in cleanup alongside the file-tree feed store.
- Replace `getFixtureSessionMetadataStore()` in the `completionProviders` memo and in the `<TugPromptEntry sessionMetadataStore={...}>` prop with the per-card live store.
- Remove the `getFixtureSessionMetadataStore` import. `wrapPositionZero` import stays (still wraps the `/` provider).
- **Decision record:** the plan originally said "shared singleton" in [Scope](#scope); the live feed is workspace-filtered, so the store is per-(card, binding), not shared. The singleton framing is wrong for a workspace-filtered feed. This sub-step records that and moves on.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- Manual: open Tide card pointed at a real project, type `/` → popup lists *actual* skills/agents from the live session (not the captured fixture).

##### Sub-step 4g — Swap `PromptHistoryStore` to live (shared, persisted) {#step-4g}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx`.
- `tugdeck/src/settings-api.ts` (if no changes needed to existing `getPromptHistory` / `putPromptHistory`, leave untouched).

**Work:**
- Introduce a module-scoped lazy singleton `getTidePromptHistoryStore(): PromptHistoryStore` in `tide-card.tsx`. First call:
  1. Construct `new PromptHistoryStore()`.
  2. Hydrate via `await getPromptHistory("tide")` (card-type-scoped shared key).
  3. Subscribe `store.subscribe(...)` to call `putPromptHistory("tide", store.getEntries())` on every change (fire-and-forget).
- `useTideCardServices` uses the singleton — no per-card construction.
- No explicit dispose; the singleton outlives any card.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- Manual: submit `> hi`, submit `> hello`, press ArrowUp → shows `> hello`; reload the page; open a new Tide card; press ArrowUp → still shows `> hello` from persisted history.

##### Sub-step 4h — Isolate the tugcode test suite from the real tugbank {#step-4h}

**Purpose:** During 4f live smoke we found the string `"s-rl"` persisted in the real `~/.tugbank.db` under `dev.tugtool.app / session-id`. Source: `tugcode/src/__tests__/session.test.ts` runs `SessionManager` with a mock Claude subprocess that emits `system:init` with `session_id: "s-rl"`. The test invokes `persistSessionId("s-rl")` via the session handler. `tugcode/src/tugbank-client.ts::getTugbankClient()` falls back to `~/.tugbank.db` when `TUGBANK_PATH` is unset. The test suite doesn't set it, so every local test run leaks whatever mock session ids it uses into the developer's real tugbank. This is the root cause of the "Claude `--resume` rejected with `Provided value 's-rl' is not a UUID`" errors seen during 4f live smoke.

**Files:**
- `tugcode/src/__tests__/session.test.ts` (or a new shared test-setup file imported by the suite).

**Work:**
- Add a `beforeAll` (or module-scope setup) that sets `process.env.TUGBANK_PATH` to a unique temp-file path created via `Bun.file`/`tmpdir`. Add an `afterAll` that removes the file.
- If other tugcode tests also touch tugbank-backed code paths, scope the fixture to the whole suite rather than per-file.
- Run the test suite once with the fix in place, then delete any stale `dev.tugtool.app / session-id` value in the developer tugbank via `tugbank delete dev.tugtool.app session-id` as a one-time operational cleanup (document in the commit message).

**Verification:**
- `bun test` in `tugcode/` runs green.
- After a full test run, `tugbank read dev.tugtool.app session-id` on the developer machine returns `not found` (confirming no leak).
- `rg '\"s-rl\"' tugcode/src tugcast` returns matches only in test fixture declarations, never in live code paths.

##### Sub-step 4i — Per-workspace session id in tugcode {#step-4i}

**Purpose:** `tugcode/src/session.ts::persistSessionId` / `readSessionId` use a single global tugbank key `dev.tugtool.app / session-id`. Every tugcode instance — across every Tide card, sequentially or in parallel — reads/writes the same key. Scenario that breaks: open card A on `/u/src/tugtool` (Claude issues session id `X`, tugcode persists `X`), close card A, open card B on `/tmp`. tugcode for B reads `X`, passes `--resume X` to Claude. Claude either errors (session `X` wasn't for `/tmp`) or worse, resumes A's context while B's project_dir is active — transcript pollution. This is a *correctness* bug that strikes the second time any user opens a card against a different project, independent of anything a single-session shim could have addressed (the shim originally scoped as [4l](#step-4l) has since been dropped in favor of [4k](#step-4k)'s fresh-by-default spawn).

**Files:**
- `tugcode/src/session.ts` (`persistSessionId`, `readSessionId`, and their callers inside `initialize`, `handleNewSession`, `handleSessionContinue`, and the `routeTopLevelEvent` session-id-persist path).
- `tugcode/src/__tests__/session.test.ts` (tests for the new keying).

**Work:**
- Replace the single-key pattern with a per-workspace pattern. Two reasonable schemas:
  1. `dev.tugtool.tide / session-id-by-workspace` (JSON value: `{ [workspaceKey: string]: string }`). One tugbank row, atomic reads/writes of the map.
  2. `dev.tugtool.tide / session-id/<workspaceKey-hash>` (one row per workspace). Cleaner for large maps; awkward for enumeration.
  Pick (1) unless there's a reason not to — the map is tiny, reads are cheap, and atomic round-trips are simpler.
- `persistSessionId` takes `(workspaceKey, sessionId)` and updates the map. `readSessionId` takes `(workspaceKey)` and returns the entry or null. Both callers thread `this.projectDir` (or a resolved workspace key if available) through.
- Decide the key: raw project_dir string, or a canonicalized hash? Server-side `workspace_key` from `spawn_session_ok` is the canonical form. tugcode doesn't have that at startup (it's spawned before the ack fires — actually, tugcast spawns tugcode AFTER validating + canonicalizing the workspace). tugcast could pass the canonical `workspace_key` as a CLI flag (`--workspace-key <key>`) when spawning tugcode. Prefer that over tugcode re-doing client-side canonicalization.
- Expose the old global key as a one-shot read fallback during the first release so existing persisted sessions aren't orphaned. Migrate on first write to the new schema; delete the old key after migration. (Optional — acceptable to drop the old key outright if the dev's tugbank is known-empty after [4h](#step-4h).)
- Update `dev.tugtool.tide / session-id-by-workspace` whenever Claude emits a real session id via `system:init`.

**Verification:**
- New unit tests: open session for workspace A, persist id `X`; open session for workspace B, persist id `Y`; read for A returns `X`, read for B returns `Y`.
- `cargo nextest run` green on the tugcast side (if any Rust-side tests touch the spawn args — e.g., `build_tugcode_command`).
- Manual: open a Tide card on `/tmp`, submit `> hi`, close the card. Open a new Tide card on `/u/src/tugtool`, submit `> hi`. Claude spawns fresh for `/u/src/tugtool` (not resumed with `/tmp`'s session id). Inspect `tugcast.log` for the claude-args line — absence of `--resume` (or presence of the *correct* resume id per workspace) is the green signal.
- `rg 'dev\.tugtool\.app.*session-id' tugcode/` returns zero matches in production code (old global key gone).

##### Sub-step 4j — Process lifecycle: tugcode exits on stdin-EOF; descendants reaped on Tug.app quit {#step-4j}

**Purpose:** During a zombie audit between 4f and 4k, `ps -ef | grep -E "/tugcode|claude.*stream-json"` showed **304 dangling processes** (152 tugcode + 152 claude, all reparented to PID 1) accumulated across multiple `just app` cycles. Root cause is a chain:

1. tugcode's `main.ts` for-await loop exits cleanly when stdin closes, but `main()` just returns. The live claude subprocess (with open stdin/stdout pipes) and its stream reader keep tugcode's event loop alive indefinitely. tugcode never exits; claude never gets killed.
2. tugcast (Rust) spawns tugcode with `kill_on_drop(true)`, but that only fires if the tokio `Child` is dropped gracefully. If tugcast is SIGKILL'd — or forcibly terminated by Tug.app on app-quit without a SIGTERM — destructors don't run and `kill_on_drop` is moot.
3. Tug.app's shutdown path may not SIGTERM tugcast and await its exit before itself dying.

Result: every ungraceful Tug.app exit leaves every session's tugcode + claude reparented to PID 1, accumulating across launches until the user notices and `kill`s them manually.

**Files:**
- `tugcode/src/main.ts` (detect stdin EOF; kill claude; `process.exit(0)`).
- `tugcode/src/session.ts` (dispose + kill the claude subprocess on session shutdown).
- `tugrust/crates/tugcast/src/main.rs` (install SIGTERM / SIGINT handlers that gracefully dispose the supervisor before exit, so tokio `kill_on_drop` actually fires on every tugcode child).
- `tugapp/Sources/ProcessManager.swift` (`applicationWillTerminate` already calls `sendFreeze`/`saveState`; add a synchronous `sendTerminate` to tugcast with a bounded wait, then fall back to SIGTERM the whole process group).

**Work:**
- **tugcode**:
  - After the `for await (const msg of readLine()) { … }` loop exits in `main()`, explicitly call `await sessionManager?.shutdown()` (which should kill the claude subprocess), then `process.exit(0)`.
  - Add a `SIGHUP` handler that mirrors the existing `SIGTERM` handler — parent death on Unix typically delivers SIGHUP when the controlling terminal closes.
- **tugcast**:
  - In `main.rs`, install a `tokio::signal` listener for SIGTERM + SIGINT. On receipt: cancel the process-wide `CancellationToken`, `drop` the supervisor (which propagates to every `SessionChild`'s `kill_on_drop`), then exit.
  - Sanity-check that the supervisor's close path waits (bounded) for tugcode children to actually exit before returning, so SIGKILL-on-app-quit timeouts don't orphan them.
- **Tug.app**:
  - On `applicationWillTerminate`, send SIGTERM to the tugcast process and wait up to ~2s for it to exit before the app terminates itself. If it doesn't exit in time, SIGTERM the process group (`kill(-pgid, SIGTERM)`) as a fallback — better to kill the group than leak descendants.

**Verification:**
- New smoke: open 5 Tide cards, send a prompt in each, quit Tug.app via `⌘Q`. Before relaunch, `ps -ef | grep -E "/tugcode|claude.*stream-json" | wc -l` returns `0`.
- Same, but via `just app` relaunch (which uses `tugrelaunch`): zombies from the previous instance should be zero before the new tugcast spawns. Add an assertion script to the `just app` flow: after relaunch, warn-log if orphaned tugcode/claude PIDs linger.
- Rust unit test: spawn a `TugcodeSpawner` child, drop the supervisor, assert the child process exits within a bounded timeout.

##### Sub-step 4k — Default every card to a fresh session {#step-4k}

**Purpose:** Even with [4i](#step-4i)'s per-workspace session-id map in place, tugcode still auto-resumes *silently* whenever a map entry exists for the card's workspace. That creates two bad outcomes the user never asked for:

1. **Concurrent same-workspace cards collide on `--resume`.** If card A is live on `/u/src/tugtool` and card B opens the same workspace, card B's tugcode reads the map, finds card A's session id, and spawns claude with `--resume <A's-id>`. Two claude processes then race on the on-disk session JSONL — transcript corruption or outright rejection. The single-session shim originally scoped as [4l](#step-4l) would have worked around this by disabling the picker on any second card; this sub-step fixes the root cause instead, and [4l](#step-4l) was then dropped.
2. **Close-then-reopen silently resumes.** Close the last card on a workspace, open a fresh one, and the new card inherits the old conversation with no user affordance to opt out or even notice. The map grows unbounded, stale entries never expire, and the only escape hatch is the `new` session slash command after the fact.

Defaulting to a fresh session on every card spawn turns both cases into the expected outcome. The full resume UX (picker radio, stale-id fallback, "Forget session" action) is scoped as [Step 4.5](#step-4-5) — this sub-step is just the safe default. As a downstream consequence, the single-session shim originally scoped as [4l](#step-4l) was dropped: with every card starting fresh, there is no session collision for the shim to guard against.

**Files:**
- `tugcode/src/session.ts` (`initialize()` only).
- `tugcode/src/__tests__/session.test.ts` (new test asserting spawn-with-`null`).

**Work:**
- In `SessionManager.initialize()`, stop reading the persisted id. Pass `null` to `spawnClaude()` unconditionally. Keep the `writeLine({ type: "session_init", session_id: "pending", … })` pattern that fresh-spawn already uses.
- Keep the `persistSessionId` write path on `system:init` so the workspace map still accumulates — [Step 4.5](#step-4-5) will read it back when the resume UX lands.
- Update or add a unit test asserting that `initialize()` spawns claude without `--resume`, even when the tugbank map already contains an entry for the current workspace key.
- [4l](#step-4l) is dropped once this lands — see that sub-step's tombstone for the rationale. No further work against the shim; the picker stays enabled regardless of how many other cards are bound.

**Verification:**
- `bun test` green on tugcode.
- `cargo nextest run` green (no Rust surface touched, but run it to catch any incidental drift).
- Manual: with a persisted map entry for `/u/src/tugtool` from the 4i smoke, open a new Tide card on that workspace; `tugcast.log` shows the claude-args line without `--resume`; the turn's `system_metadata` frame carries a *new* session id.
- Manual: open two Tide cards on `/u/src/tugtool` concurrently; each spawns its own fresh claude; no transcript cross-talk.

##### Sub-step 4l — Single-session shim (dropped) {#step-4l}

**Status:** Dropped. No code change required. Retained in the plan as a decision-trail entry; renumbering the later sub-steps to close the gap would erase the history of why this shim was considered and then discarded.

**Original intent:** Render `<TideProjectPicker>` disabled (input + button greyed, banner "Single-session mode — close the other Tide card first") whenever any other Tide card already held a binding in `cardSessionBindingStore`. The shim was written on the pre-[4i](#step-4i) assumption that two concurrent Tide cards would collide — either on a shared `--resume <id>` from the global tugbank key or on a presumed pre-P2 backend limit of one session at a time.

**Why dropped:**
- [4i](#step-4i) replaced the global `dev.tugtool.app / session-id` key with a per-workspace map, so two cards on *different* workspaces no longer share a resume id.
- [4k](#step-4k) defaults every card spawn to a fresh session (no auto-resume), so two cards on the *same* workspace no longer share a session id either. Each card gets its own tugcode subprocess, its own claude subprocess, its own JSONL. No collision to shim around.
- The [4i](#step-4i) live smoke (see the cross-workspace A/B at 2026-04-18) demonstrated the backend handling two concurrent sessions with no cross-talk. The "pre-P2 single-session backend" premise the shim was guarding against does not appear to reflect the current system; P2 may be about multi-client, not multi-session.
- The shim's scope ("block the existence of any second Tide card") was broader than any bug it actually prevented post-[4k](#step-4k). It would have blocked scenarios the user legitimately wants — e.g., two cards on the same project for parallel conversations, or two cards on different projects. That's a policy the user should decide, not the card.

**What the future UX should still address** (folded into [Step 4.5](#step-4-5), not a revived 4l):
- If two cards on the *same* workspace both opt into "resume last session," only one can win — the other must either be rejected, downgraded to a fresh session with a notice, or warn the user at pick time. That choice is a design question for the resume UX, not a pre-emptive shim.
- If concurrent-same-workspace turns out to have subtle file-write or feed-subscription hazards in practice, the mitigation lives at the layer that observes the hazard (editor conflict UI, claude-side locking, etc.), not in a blanket picker disable.

**Action:** None. Proceed from [4k](#step-4k) directly to [4m](#step-4m).

##### Sub-step 4m — Recent projects + opportunistic cleanup {#step-4m}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (recent-projects UI).
- `tugdeck/src/components/tugways/cards/tide-card.css`.
- `tugdeck/src/settings-api.ts` (new `readTideRecentProjects` + `putTideRecentProjects` helpers).

**Work:**
- **Tugbank helpers** in `settings-api.ts`: `readTideRecentProjects(tugbank): string[]` and `putTideRecentProjects(tugbank, paths: string[]): void`. Tugbank domain `dev.tugtool.tide`, key `recent-projects`, value `{ paths: string[] }`. Cap 5, most-recent-first, de-duplicated.
- **Picker UI:** below the text input, render up to 5 quick-pick buttons for recent paths. Click fills the input and submits in one gesture (single click = fill + spawn).
- **Persist on bind success:** when a binding appears for this card (subscription fires), prepend `binding.projectDir` to the recents list (dedup; cap 5); call `putTideRecentProjects`.
- **Opportunistic cleanup** (easy wins encountered while adding the recents UI): zero `// eslint-disable`, zero `any`, zero `@ts-expect-error`, zero descendant-selector reach-ins in `tide-card.tsx`/`tide-card.css`. The scorched-earth mock/fixture scrub is [4n](#step-4n), not here.
- **Integration test:** end-to-end `bun test` that mounts the card against a fake connection seam → submits picker → simulates `spawn_session_ok` → asserts services construct + binding appears + recent-projects gets the path; then unmounts → asserts `encodeCloseSession` frame sent + binding cleared. The fake connection used in this test is a test-only double in `__tests__/`; production `tide-card.tsx` imports none of it ([4n](#step-4n) enforces this).

**Verification:**
- `bun x tsc --noEmit` + `bun test` green.
- `rg 'eslint-disable|@ts-expect-error|\bany\b' tugdeck/src/components/tugways/cards/tide-card.tsx` returns zero matches.
- Manual: open Tide card, enter `/tmp` → submit → split pane renders; reload; open another Tide card → recents list shows `/tmp` as a quick-pick button; clicking it spawns in one click.

##### Sub-step 4n — Mock/fixture scrub (hard exit criterion) {#step-4n}

**Purpose:** No "Mock" or fixture objects allowed to linger in the Tide card's production code path. Every mock seam introduced by the Step 1 copy or referenced through intermediate sub-steps must be out of production code by the time this sub-step commits. Test-only doubles remain, but scoped to `__tests__/` — never imported from production modules.

**Scope — the production code path for the Tide card:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx`
- `tugdeck/src/components/tugways/cards/tide-card.css`
- any helper file introduced by sub-steps 4a–4i that `tide-card.tsx` imports (inline picker component, tugbank helpers, singleton factories)
- any new helper files imported *transitively* by the above that exist only to serve the Tide card

**Out of scope (left untouched):**
- `gallery-prompt-entry.tsx` / `gallery-prompt-entry.css` (per [D6](#resolved-decisions)) — gallery still uses mocks, deliberately.
- `gallery-prompt-entry-sandbox` — synthetic-frame harness, mocks expected.
- `gallery-prompt-input.tsx` — also mock-backed; separate from this plan.
- `MockTugConnection` module itself (`tugdeck/src/lib/code-session-store/testing/mock-feed-store.ts`) — stays, used by gallery and by Tide's own `__tests__/` doubles.
- Test files (`__tests__/*.test.ts*`) — are allowed to import mocks for the connection seam.

**Work:**
- **Audit.** Run the following greps against the in-scope files and confirm every match either originates from a test-only import (which should already be absent from production imports) or represents a false positive that can be renamed / removed:
  - `rg -i '\bmock' <scope>` — case-insensitive `mock` in identifiers, comments, string literals. Includes `MockTugConnection`, `mockSessionRef`, `getMock*`, `withMockBinding`, etc.
  - `rg -i '\bfixture' <scope>` — `getFixture*`, `fixture-` filenames, comment references.
  - `rg 'testing/' <scope>` — anything pulling from the test-double tree.
- **Remove** every match that comes from production code. Expected removals, given the preceding sub-steps:
  - `MockTugConnection` import (dropped in 4e, verify gone here).
  - `TIDE_TUG_SESSION_ID` constant (mock-only; removed here if still present).
  - `getFixtureSessionMetadataStore` / `wrapPositionZero` import if either is still there after 4f. `wrapPositionZero` is fine to keep if it lives in a non-fixture module; if it's still inside `completion-fixtures/system-metadata-fixture.ts`, move it to a production helper (e.g., `tugdeck/src/components/tugways/cards/completion-providers/position-zero.ts`) and update imports. After the move, the Tide card imports only from the new home.
  - Any inline `// mock-backed` / `// fixture` comments — turn them into factual descriptions or delete.
- **Relocate test doubles.** The integration test introduced in [4m](#step-4m) uses a fake connection. Confirm it lives under `tugdeck/src/components/tugways/cards/__tests__/tide-card.test.tsx` (or similar) and that its fake connection is constructed there, not reached through production imports.
- **Rename for clarity.** If any production identifier still contains `mock`, `fake`, `stub`, or `dummy` after the removals above, rename.
- **Grep gate.** After the audit, these must pass:
  - `rg -i 'mock' tugdeck/src/components/tugways/cards/tide-card.tsx tugdeck/src/components/tugways/cards/tide-card.css` → **zero matches**.
  - `rg -i 'fixture' tugdeck/src/components/tugways/cards/tide-card.tsx tugdeck/src/components/tugways/cards/tide-card.css` → **zero matches**.
  - `rg '/testing/' tugdeck/src/components/tugways/cards/tide-card.tsx` → **zero matches**.
  - `rg 'TIDE_TUG_SESSION_ID' tugdeck/src/components/tugways/cards/tide-card.tsx` → **zero matches**.
  - Same greps applied to any new helper module created by 4a–4i and imported from `tide-card.tsx` → **zero matches**.
- **Follow the imports.** If `tide-card.tsx` imports a helper module (picker, singleton factory, tugbank helper, position-zero wrapper), the grep gate above applies transitively: run the same greps on each such module.
- **Tuglaws re-check.** After the scrub, walk `tide-card.tsx` + all imported helpers once more against [tuglaws.md](../tuglaws/tuglaws.md). Every law either applies and is satisfied, or explicitly does not apply. This is the Step 4 contribution to the plan-level Tuglaws adherence exit criterion.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green (test file still compiles with its own fake connection; production never did import the mock tree after 4e).
- All grep gates listed under **Work** return zero matches.
- Manual smoke: open a Tide card against live `tugcast` + `claude`, enter a project path, submit `> hi`, confirm end-to-end Claude round-trip. Nothing behaves differently vs. 4i; 4j is a code-hygiene commit, not a behavior change.

##### Step 4 rollup verification

After all fourteen sub-steps land:

- `bun run check` exits 0. `bun test` exits 0 with at least the integration test from [4m](#step-4m). `bun run audit:tokens lint` exits 0. `cargo nextest run` exits 0 (no Rust regressions from the binding store usage).
- Manual: type a path; picker disappears; entry renders; submit `> hi`; a real Claude response streams in via `TugMarkdownView` (arrives in [Step 5](#step-5) — in Step 4 the top pane is still the placeholder). Step 4's live-smoke is the `assistant_text` event arriving on the `CodeSessionStore`; visual rendering of the stream is Step 5's concern.

#### Step 4.5 — Resume-vs-new session UX (minimum viable) {#step-4-5}

**Purpose:** Give the user an explicit choice between starting a fresh Claude session and resuming a prior one for the same workspace, replacing the fresh-by-default behavior of [4k](#step-4k) with a user-controlled default. 4.5 ships the smallest plumbing that surfaces the choice: one resume target per workspace (the most recent, already persisted in the `session-id-by-workspace` map), a list-shaped picker with a confirmation button, and a stale-id fallback that is loud, not silent. Everything richer — multiple historical sessions per workspace, ledger-backed previews with first-prompt snippets and turn counts, concurrent-resume collision handling, eviction policies, explicit forget — is [Step 4.6](#step-4-6).

**Why this ships as a small first cut:** The map at `dev.tugtool.tide / session-id-by-workspace` already stores a single id per workspace (as of [4i](#step-4i)). 4.5 exposes that one id as a resume option and wires `sessionMode` through tugdeck → tugcast → tugcode. No schema migration, no new storage, no new component primitives beyond a styled radio group. A proper table / session-history component is not built here; it arrives with [4.6](#step-4-6) once the tugcast-side ledger is behind it.

**UX shape:**
- The picker keeps its path input and recents list from [4m](#step-4m). The recents buttons change gesture: a click *fills the path input*; it no longer auto-submits with fresh-spawn. Confirmation is always via the Open button. (Code comment references 4.5 so future readers understand the 4m regression.)
- Below the path input, a vertical list of **session options** for the typed/selected workspace, rendered as an ARIA `role="radiogroup"` of rows, each row a `<button role="radio" aria-checked="…">`:
  - **Row 1 — "Start fresh".** Always present, selected by default. Subtitle: "New conversation".
  - **Row 2 — "Resume last session".** Rendered only when the map has an entry for the typed path. Subtitle: the relative timestamp of the last spawn for that id (derived from tugbank write time; no first-prompt snippet yet — that is [4.6](#step-4-6)).
- Keyboard: arrow keys move selection within the radio group; Enter submits (same as clicking Open).
- No table component. A styled `<div role="radiogroup">` with token-driven selection state is sufficient for 0–1 resume rows. The real session-history surface arrives with [4.6](#step-4-6).

**Plumbing:**
- `CardSessionBinding` grows `sessionMode: "new" | "resume"` alongside `projectDir` / `workspaceKey` / `tugSessionId`.
- `spawn_session` CONTROL payload grows a `session_mode: "new" | "resume"` field. `encodeSpawnSession(cardId, tugSessionId, projectDir, sessionMode)` — absent mode defaults to `"new"` on the decode side so pre-4.5 frames remain valid.
- tugcast's supervisor parses `session_mode` from the CONTROL payload and forwards it through `run_session_bridge` / `ChildSpawner::spawn_child`. `build_tugcode_command` emits `--session-mode new|resume`.
- tugcode's `main.ts` parses `--session-mode`, defaults to `"new"`; `SessionManager.initialize()` branches:
  - `"new"`: current [4k](#step-4k) behavior — skip `readSessionId()`, call `spawnClaude(null)`.
  - `"resume"`: read the per-workspace map via `readSessionId()`, pass the id to `spawnClaude(id)`.
- Stale-id fallback in tugcode: if `spawnClaude(id)` fails in `"resume"` mode (claude exits non-zero, session JSONL missing, "not a UUID", etc.), tugcode:
  1. Emits a new IPC frame `resume_failed { card_id, tug_session_id, reason }` on the supervisor's control feed.
  2. Clears the stale entry from the `session-id-by-workspace` map for `this.workspaceKey` only.
  3. Calls `spawnClaude(null)` — a fresh spawn — so the card still becomes usable.
- `resume_failed` routing: tugcast surfaces the frame as a CONTROL ack to the card; `action-dispatch.ts` converts it into `codeSessionStore.setLastError({ category: "resume_failed", reason })`. [Step 6](#step-6)'s `lastError` affordance renders it with no new banner machinery.

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` — picker UI change; `sessionMode` state; submit encodes the mode; recents gesture change.
- `tugdeck/src/components/tugways/cards/tide-card.css` — radio-group rows; selected-state tokens.
- `tugdeck/src/lib/card-session-binding-store.ts` — add `sessionMode` to `CardSessionBinding`.
- `tugdeck/src/protocol.ts` + `tugdeck/src/lib/session-lifecycle.ts` — extend `encodeSpawnSession` with `session_mode`.
- `tugdeck/src/action-dispatch.ts` — propagate `session_mode` from `spawn_session_ok` into the binding; route `resume_failed` into `lastError`.
- `tugrust/crates/tugcast/src/actions.rs` — add `session_mode` to the `SpawnSession` CONTROL struct; add `ResumeFailed` variant on the supervisor-emitted CONTROL enum.
- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — parse `session_mode`; forward through `run_session_bridge`; route tugcode-emitted `resume_failed` to the card's control feed.
- `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` — thread `session_mode` through `ChildSpawner`; `build_tugcode_command` emits `--session-mode`.
- `tugcode/src/main.ts` — parse `--session-mode`; default `"new"`.
- `tugcode/src/session.ts` — `SessionManager` constructor takes mode; `initialize()` branches; stale-id fallback emits `resume_failed`, clears the map entry, fresh-spawns.

**Work:**
- **Binding + payload shape.** Add the `sessionMode` field to `CardSessionBinding` and the CONTROL `spawn_session` payload (both sides). Default to `"new"` on every decode path so pre-4.5 frames don't break.
- **Picker UI.** Reshape `TideProjectPickerForm`: input at top, recents list below (now *path-filler* buttons, not spawners), then the session-mode radio group, then the Open button. The radio group re-reads the tugbank map for the typed path whenever the path changes (via `getTugbankClient()` as in 4m).
- **Submit.** On Open, read the selected `sessionMode` and include it in `encodeSpawnSession`. The `spawn_session_ok` handler propagates `session_mode` into the binding.
- **Supervisor plumbing.** `SpawnSession` parsing learns `session_mode`; `run_session_bridge` grows a `session_mode: SessionMode` parameter; `build_tugcode_command` emits the flag for each variant.
- **tugcode flag + branch.** Parse `--session-mode`. `SessionManager` constructor takes the mode; `initialize()` branches. `persistSessionId` on `system:init` stays unchanged so both modes write back the latest id (resume writes the same id; fresh writes the new one).
- **Stale-id fallback.** In `SessionManager.initialize()`'s `"resume"` branch, wrap `spawnClaude(id)` with a recovery block: on failure, emit a `resume_failed` IPC frame, clear the map entry for `this.workspaceKey`, call `spawnClaude(null)`. Log the failure mode to the tugcast tracing log.
- **`resume_failed` routing.** Supervisor wraps the frame as a CONTROL ack to the card; `action-dispatch.ts` converts it into `codeSessionStore.setLastError({ category: "resume_failed", reason })`. No new UI component — Step 6's affordance renders it.
- **Recents gesture change.** Clicking a recent path fills the input; it does not spawn. Brief code comment pointing to 4.5 explains the regression from 4m's single-click behavior.

**Verification:**
- `bun x tsc --noEmit` + `bun test` green. New tests in `tide-card.test.tsx`:
  - T-TIDE-RESUME-01: picker with no map entry renders only the "Start fresh" row.
  - T-TIDE-RESUME-02: picker with a map entry for the typed path renders both rows; "Start fresh" is selected by default.
  - T-TIDE-RESUME-03: selecting "Resume last" + clicking Open sends `encodeSpawnSession(..., sessionMode: "resume")`.
  - T-TIDE-RESUME-04: changing the path input re-reads the map and updates the resume row's visibility.
  - T-TIDE-RESUME-05: a `resume_failed` frame arriving on the bound session populates `CodeSessionStore.lastError` and does not unbind the card.
  - T-TIDE-RESUME-06: clicking a recent fills the input and does not send a CONTROL frame.
- New tests in `tugcode/src/__tests__/session.test.ts`:
  - `"new"` mode skips `readSessionId`, passes `null` to the (mocked) `spawnClaude`.
  - `"resume"` mode reads the seeded map and passes the id.
  - `"resume"` mode with a failing `spawnClaude` emits `resume_failed`, clears the map entry, re-spawns with `null` and succeeds.
- New Rust tests: `build_tugcode_command` with each `SessionMode` variant emits the expected flag.
- `cargo nextest run` green. `bun run audit:tokens lint` green.
- Manual smoke (three scenarios):
  1. Open a card on `/u/src/tugtool`; pick Start fresh; send `> remember that my favorite color is green.`; observe the acknowledgment; close the card.
  2. Open a new card on `/u/src/tugtool`; observe both rows; pick Resume last; click Open; send `> what did I tell you to remember?`; verify claude responds with "green".
  3. Move `~/.claude/projects/<workspace>/<session>.jsonl` aside to simulate a stale id; open a card; pick Resume last; observe the card bind (via the fresh-spawn fallback), `lastError` affordance shows a resume-failed notice, submit `> hi` succeeds; verify the map entry now points to the new id, not the moved one.

**Out of scope (see [Step 4.6](#step-4-6)):**
- Multiple historical sessions per workspace. The tugbank map holds one id; 4.5 exposes one resume row. [4.6](#step-4-6) introduces a tugcast-side ledger that stores N sessions per workspace.
- Session previews beyond a timestamp (no first-prompt snippet, no turn count, no state indicator).
- Concurrent-resume collision handling. If two cards on the same workspace both pick Resume in 4.5, behavior is undefined beyond "last writer wins on `persistSessionId`". [4.6](#step-4-6) introduces live-binding awareness in the ledger and greys out the row.
- Eviction, explicit Forget actions, recents↔ledger coherence, cross-card live updates. All deferred to [4.6](#step-4-6).
- Migrating session bookkeeping off tugbank. [4.6](#step-4-6) moves it to a purpose-built ledger.

#### Step 4.5.5 — Audit and harden the session-id / prompt-history chain {#step-4-5-5}

**Purpose:** [4.5](#step-4-5) shipped the resume-vs-new picker and rerouted prompt history off the divergent `tug_session_id`. Manual testing then surfaced a class of bugs that share one root cause: when a `--resume` attempt fails, tugcode silently mints a fresh uuid and respawns under it, so the live `claude_session_id` quietly drifts away from the id the user picked, the id the binding holds, and the id the prompt-history is keyed under. From the user's seat this looks like "history randomly disappears" and "I can resume the same session twice." 4.5.5 is the audit + remediation that makes that drift impossible (or, where impossible is too strong, loud and recoverable).

**Why before 4.6:** [4.6](#step-4-6) replaces tugbank-as-session-store with a purpose-built tugcast-side ledger and a richer picker. Building that ledger on top of a flow that silently rebrands sessions would carry the bug forward in a much richer surface. Fix the chain first; then move it.

**Audit findings (the chain, end-to-end):**

The two identifiers in birth order:
1. **`tug_session_id`** — picker mints (`crypto.randomUUID()` for new, or picks the most recent record for resume). Travels: picker → `spawn_session` CONTROL frame → supervisor `LedgerEntry` key → `--session-id` to tugcode → claude's `--session-id` (new) or `--resume` (resume). Used as the tugcast feed routing key for the lifetime of the session.
2. **`claude_session_id`** — claude emits in `system:init`. Captured by tugcode → relayed as `session_init` IPC → parsed by tugcast bridge → written into `LedgerEntry.claude_session_id`, used as the key for the `dev.tugtool.tide / sessions` record, and (after 4.5) used as the prompt-history key.

For "new" with `--session-id <id>`, claude is supposed to adopt that id, so the two should be equal. For "resume", claude reuses the existing id, so they're equal. **Divergence happens only when tugcode silently fresh-spawns after a failed resume** (`tugcode/src/session.ts::initialize` post-4.5: on `attemptResumeSpawn` returning false, `this.sessionId = crypto.randomUUID()` and a fresh spawn). When that path fires:
- `tug_session_id` (LedgerEntry key, feed routing key, binding) = the original (failed-resume) id
- `claude_session_id` (sessions record key, history key) = a brand-new uuid
- The card looks bound and usable; the user thinks they resumed; they did not. Any history under the failed id is orphaned.

Fragility map (with severity):

- **F1 — Silent resume fallback (the smoking gun, severity: critical).** `tugcode/src/session.ts::initialize` mints a new uuid and respawns when `--resume` fails. The card never closes; `claudeSessionId` quietly switches to the new id; the user's intent is silently lost. Every other "history disappeared" report traces back here.
- **F2 — Sessions record write is async after `session_init` (severity: medium).** Bridge calls `sessions_recorder.record(claude_id, project_dir)` only after parsing `session_init`. Between picker-submit and the first `session_init`, no record exists. If a second card opens the same project in that window, the picker shows "no resume."
- **F3 — Tugbank cache propagation lag (severity: medium).** Tugcast `TugbankClient.set()` writes sqlite + auto-broadcasts `domain-changed`. Tugdeck receives via DEFAULTS feed and updates its local cache. Picker reads from that cache synchronously. There is a non-zero window where a just-closed session's record (or a just-removed stale record) has not reached the picker yet.
- **F4 — Concurrent resume of the same session (severity: high).** Picker offers "Resume last" without checking liveness. Two cards on the same project both pick Resume → both pass the same `--resume <id>`. Claude rejects (or undefined-behavior's) the second → second card falls into F1's silent fallback. The "I can resume the same session twice" report is exactly this.
- **F5 — History push race against `claudeSessionId === null` (severity: low).** TugPromptEntry's submit short-circuits when `snap.claudeSessionId === null`. If a user submits in the spawn-handshake window, the push is silently dropped. Rare in practice.
- **F6 — Picker has no pre-flight validation (severity: low).** `resumeCandidate` picks `readSessionsForProject(path)[0]` and submits it as-is. If the underlying jsonl is missing (user cleaned `~/.claude/projects/`, claude config changed), spawn fails → F1 fires. There's no "resume target unavailable" affordance before the spawn.

The plumbing on the tugcast and tugdeck sides is correct after 4.5; the failure mode is `--resume` quietly becoming `--session-id`. **Closing F1 makes F4 surfaceable, makes F6 worth fixing, and makes F2/F3 contained instead of compounding.**

**Strategy:** Five phases, smallest-blast-radius first. Phase A is read-only observability. Phase B is the headline behavior change (kill the silent fallback). Phases C–E address the remaining fragilities and lock down regressions with end-to-end tests.

**Phase A — Make the chain observable (no behavior change):**

- Add a structured trace tag (e.g. `tide::session-lifecycle`) that fires at every handoff: picker decision (`tug_session_id`, mode), `spawn_session` frame send/receive, supervisor `do_spawn_session` entry, bridge `spawn_child` call (`session_id`, mode), tugcode `initialize()` start/end (mode in, mode out, fallback taken or not), `session_init` parse (`tug_session_id`, `claude_session_id`), `sessions_recorder.record` / `.remove`, tugdeck CodeSessionStore reception of `session_init`, TugPromptEntry provider creation, PromptHistoryStore PUT/GET URLs.
- One scan of the log answers "which id won, and where?" for any session run.
- No behavior change; tests still green.

**Phase B — Kill the silent resume fallback (the headline fix):**

- **Remove the silent fresh-spawn fallback from `tugcode/src/session.ts::initialize`.** On `--resume` failure, tugcode emits `resume_failed { reason, stale_session_id }`, runs `shutdown()`, exits cleanly. No new uuid, no fresh spawn from inside tugcode.
- **Tugcast supervisor sees the bridge end before `session_init`.** It already publishes `SESSION_STATE = errored { detail }` on bridge crash; the `resume_failed` IPC line is parsed first and forwarded to the card so `lastError` carries the user-facing reason. The stale sessions record removal (already in 4.5) stays.
- **Tugdeck reacts to the bridge ending:** the existing `lastError` channel fires, the card stays unbound (or unbinds if it had bound), and the picker re-presents itself with:
  - The failed session id removed from the resume list (already removed from the sessions record by tugcast).
  - A short notice — "Couldn't resume `<id>` — it may have been deleted or is in use elsewhere. Pick a different option below." — rendered above the radio group, dismissible.
  - Default radio selection: "Start fresh".
- **No silent state change, ever.** The user sees the failure and chooses what to do next. This is the design B from the audit memo; the silent path is what got us here.

**Phase C — Eliminate concurrent-resume races (F4):**

- **Live-session set lives in tugcast** (in-memory; rebuilt on tugcast restart from the live ledger entries). `LedgerEntry::Live` is the source of truth for "this session is currently bound to a card." On `do_spawn_session` for a `session_mode="resume"` payload whose `session_id` matches a `Live` entry on a different `card_id`, the supervisor rejects with `ControlError::CapExceeded { reason: "session_live_elsewhere" }` and broadcasts `SESSION_STATE = errored { detail: "session_live_elsewhere" }`. The router maps both to a CONTROL error frame on the in-scope socket.
- **Picker greys out resume rows that point at a session live on another card.** Tugdeck does not have the supervisor's live set on the wire today; the simplest path is to broadcast a `live-sessions` set on the DEFAULTS feed (tugcast-owned domain `dev.tugtool.tide`, key `live-sessions`, value: `[session_id, ...]` JSON). Picker subscribes via the existing DEFAULTS pipe and disables the resume row when the candidate is in the set.
- **Pre-flight validation in tugcode** (defense in depth, before the wire-side check): before spawning `--resume <id>`, tugcode `stat`s the expected jsonl path (`~/.claude/projects/<workspace-encoded>/<id>.jsonl` per claude's convention). If it's missing, emit `resume_failed { reason: "missing_jsonl" }` immediately rather than letting claude fail. Cheap and removes a slow failure mode.

**Phase D — Tighten the identifier model (F2, F5, plus general hygiene):**

- **Persisted records key on `claude_session_id` only** (already true after 4.5 for prompt history; verify the sessions record and any future ledger row obey the same rule). `tug_session_id` keeps its single job: routing key during the spawn-handshake window before claude has assigned an id.
- **`CardSessionBinding` carries both ids.** The binding store grows `claudeSessionId: string | null` alongside `tugSessionId`. `claudeSessionId` is populated when `session_init` arrives (via a new `bindClaudeSessionId` action) and is cleared on close. Picker, prompt-history, and any future ledger reads consume `claudeSessionId` exclusively; `tugSessionId` is a tugcast-side concern not surfaced in user-facing UI.
- **Buffer history pushes during `claudeSessionId === null` (F5).** TugPromptEntry holds a small per-card buffer (e.g. `pendingHistoryPushes: HistoryEntry[]`); on `session_init` reception (the same effect that switches the provider) the buffer flushes into `historyStore.push(...)` keyed under the freshly-arrived `claudeSessionId`. Submit during the handshake window no longer drops the entry.
- **`tug_session_id` is internal vocabulary.** Audit user-facing strings (notices, error messages, anything rendered to the user) for `tug_session_id` references and replace with `claude_session_id` (or "session"). Keep `tug_session_id` in tugcast/router/wire-protocol code and developer logs.

**Phase E — End-to-end tests that mirror reality:**

- Use the existing `tugcast` + `tugcode` integration test harness (the "fake claude" fixture catalog) to drive scenarios end-to-end:
  - **R-CHAIN-01 — Fresh new.** Picker mints id `X`; spawn succeeds; claude emits `session_init { session_id: X }`; sessions record contains `X`; prompt push lands under `X`; subsequent fetch returns the entry.
  - **R-CHAIN-02 — Resume success.** Sessions record pre-seeded with `X`; picker offers Resume; spawn succeeds; `session_init { session_id: X }`; binding's `claudeSessionId === X`; history loaded under `X` survives the round trip.
  - **R-CHAIN-03 — Resume failure → no silent fallback.** Sessions record contains `X`; jsonl is absent; picker offers Resume; tugcode emits `resume_failed`, exits; sessions record `X` is removed; card stays unbound; `lastError` is populated with the reason; picker is re-presented with notice. **No `claudeSessionId` ever takes a value other than `X` for this attempt.**
  - **R-CHAIN-04 — Two cards same project, both Resume.** Card A picks Resume, binds successfully under `X`; Card B picks Resume on the same project; supervisor rejects with `session_live_elsewhere`; Card B's picker disables the resume row and surfaces the reason.
  - **R-CHAIN-05 — Submit during handshake (F5).** Spawn frame sent; user submits before `session_init` arrives; `session_init` arrives; the submit is included in the prompt history under the freshly-arrived `claudeSessionId`.
  - **R-CHAIN-06 — Close mid-stream then resume.** Send a turn; close mid-stream; reopen via Resume; history under that `claudeSessionId` is intact (round-trips through tugbank).
- Each scenario asserts on the **session-lifecycle log shape** (Phase A) in addition to user-visible state, so future regressions show up as log-shape diffs. Keep asserts on log lines tight to the structured fields, not the human prose.
- Existing `tide-card.test.tsx` and `tug-prompt-entry.test.tsx` tests stay green; new `R-CHAIN` tests live in a dedicated file (e.g. `tugdeck/src/__tests__/session-chain.integration.test.ts`) so the unit tier and the chain tier remain visually separate.

**Files (anticipated; promotion pass refines):**

- `tugcode/src/session.ts` — remove silent fallback in `initialize()`; tighten `attemptResumeSpawn` to bubble failure cleanly. Add the `stat` pre-flight for `--resume`.
- `tugcode/src/main.ts` — exit non-zero on `resume_failed` so the supervisor sees a clean signal.
- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — `do_spawn_session` checks the live set for `session_mode="resume"`; rejects with `session_live_elsewhere` when the id is bound elsewhere. Maintains the live-sessions set; broadcasts on change to the DEFAULTS feed.
- `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` — wire the `tide::session-lifecycle` traces around the existing handoff points.
- `tugdeck/src/lib/card-session-binding-store.ts` — add `claudeSessionId: string | null`; populate from `session_init`; clear on close.
- `tugdeck/src/components/tugways/cards/tide-card.tsx` — picker subscribes to `live-sessions` from DEFAULTS; greys out resume rows accordingly. On `lastError.category === "resume_failed"` the picker re-presents itself with the notice.
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` — buffer push entries until `claudeSessionId` is non-null; flush on first `session_init` reception.
- `tugdeck/src/lib/code-session-store/reducer.ts` — `session_init` reduces to `bindClaudeSessionId` action that populates the binding store.
- `tugdeck/src/lib/prompt-history-store.ts` — no behavior change expected; verify the pending-load coalescing still holds with buffered pushes.

**Verification:**

- `bun x tsc --noEmit` + `bun test` green; `cargo nextest run` green; `bun run audit:tokens lint` green.
- New `R-CHAIN-01..06` tests pass (Phase E).
- Manual smoke (the tests should make this redundant, but run it once to confirm):
  1. Open a card on `/u/src/tugtool`; submit a prompt; close; reopen; pick Resume; verify the conversation is restored and the prompt history (arrow-up) returns the previous entries.
  2. Move the relevant `~/.claude/projects/.../<id>.jsonl` aside; open a card; pick Resume; verify the card does **not** silently bind to a fresh session — instead, the picker re-presents with the resume-failed notice.
  3. Open card A on `/u/src/tugtool`, pick Resume successfully; open card B on the same project; verify card B's Resume row is greyed with the "session is live in another card" reason.
- Session-lifecycle log scan: for each scenario above, walk the log and confirm the id flow matches the expected shape (no surprise new uuids; no silent rebranding).

**Out of scope (deferred to [4.6](#step-4-6)):**

- Multiple historical sessions per workspace beyond the most-recent-one shape that 4.5 already exposes. 4.5.5 makes the existing single-session-per-workspace flow correct; 4.6 introduces the ledger that lets the picker show N sessions with metadata.
- Forget actions, eviction policies, recents↔ledger coherence. All ledger-shaped, all 4.6.
- Migrating the sessions record off tugbank into the tugcast-side ledger. 4.5.5 keeps the same storage; 4.6 moves it.

**Tradeoff (the redirectable one):**

The largest design call is **B vs. keep silent fallback**. B is correct: the user's intent is honored or the failure is surfaced. The current silent fallback "always succeeds" but loses intent and produces the bug class this step exists to address. **B is the chosen direction** (decided 2026-04-18); record any reversal here with the rationale.

#### Step 4.5.6 — Post-implementation audit: pre-flight removal, services-store refactor, and tuglaws compliance {#step-4-5-6}

**Purpose:** [4.5.5](#step-4-5-5) shipped Phases A–E and was audited at the end. The audit caught real issues; the fixup commit addressed most. Manual retesting then exposed a bug class I had introduced and missed: the picker reappeared mid-conversation after a successful submit, and resume of a saved session never restored history. This step documents the root causes, the architectural fix, the surviving smaller items, and what to verify before declaring 4.5.5 truly closed.

**Root causes (in the order they were found):**

1. **L02 violation in `useTideCardServices`.** The hook stored `services` in `useState<services>` and populated it via a `useLayoutEffect` keyed on the binding. Per [L02] (External state enters React through `useSyncExternalStore` only — no `useEffect` copying external values into React state), this is a direct violation. The symptom was a class of bugs where any binding-field update (Phase D's `bindClaudeSessionId` was the immediate trigger, but anything that mutated the binding object would do it) would tear services down, send a stray `close_session` frame to the supervisor, and remount the picker mid-conversation. Every workaround I tried — depending on `bindingTugSessionId` instead of the binding object, reading `liveBinding` inside the effect, narrowing dependency arrays — was a patch around the same broken architecture.

2. **Wrong path encoding in tugcode's resume pre-flight.** The pre-flight stat in `attemptResumeSpawn` checked `~/.claude/projects/<encoded-projectDir>/<sessionId>.jsonl` where `encoded` replaced `/` with `-`. claude itself uses the *resolved* canonical cwd (which on macOS resolves firmlinks like `/u → /Users/kocienda/Mounts/u`), so the actual file lives at `~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/<id>.jsonl` while the pre-flight stats `~/.claude/projects/-u-src-tugtool/<id>.jsonl`. Every resume on this machine silently failed with `missing_jsonl` before claude was ever invoked, and the bridge promoted the EOF to `RelayOutcome::ResumeFailed`. The "defense in depth" optimization defended against nothing and broke the only thing that mattered.

3. **`PromptHistoryStore._lastActiveSessionId` written without a `_version` bump (mild).** `createRouteProvider` writes `_lastActiveSessionId` but does not bump `_version`. The cached snapshot's `sessionEntries` field can read stale. No consumer reads `sessionEntries` today, so this is a footgun rather than a live bug. Fix or document.

4. **`PromptHistoryStore.loadSession` only notifies on non-empty entries (mild).** A 404 result marks `_loadedSessions.add(X)` but does not bump `_version` or notify. Anyone relying on "load completed" as a notification is silently missed. No consumer cares today; the route providers read `_sessions` directly.

5. **Integration tests' hand-mirror of `useTideCardObserver` (smell).** `session-chain.integration.test.ts::installCardObserver` duplicates the production observer body. Now that `use-tide-card-observer.ts` exists as a standalone module, the mirror should be replaced with the real hook (or the test pattern reshaped to drive through React Testing Library).

**Architectural fix (the real one):**

- **`CardServicesStore`** (new, `tugdeck/src/lib/card-services-store.ts`): module-scope owner of per-card service bags. Subscribes to `cardSessionBindingStore` *once* at module init. On `_reconcile`, constructs services for new bindings and disposes services for vanished bindings. React reads the resulting map via `useSyncExternalStore` ([L02]) — services have a stable identity across React re-renders for the lifetime of the binding.
- **`useTideCardServices`** is now a thin reader: `useSyncExternalStore(cardServicesStore.subscribe, () => cardServicesStore.getServices(cardId))`. No `useState`, no `useLayoutEffect` copying external state. L02-compliant.
- **Wire `close_session` is now explicit.** The cleanup in `useTideCardServices` no longer sends close. The wire frame is sent only by `cardServicesStore.closeCard(cardId)`, called from the deck-canvas's user-close handler before `store.handleCardClosed(cardId)`. Bare React unmount (parent re-render, dep change, reconcile) does NOT send close. The session lives until the user explicitly closes the card or the bridge tears down via `resume_failed`.
- **Reference stability is structural.** When `bindClaudeSessionId` mutates the binding (creating a new map entry), `cardSessionBindingStore` notifies, `_reconcile` runs, but the `cardId` is still in both `bindings` and `_services` → no construct, no dispose, no React notification. Services keep their identity across binding-field updates. The cleanup that was sending the spurious close on every binding mutation is gone — there is no React-effect cleanup for services anymore.

**Pre-flight removal:**

- `expectedSessionJsonlPath`, `_existsSync`, and `setExistsSyncForTest` removed from `tugcode/src/session.ts`. `attemptResumeSpawn` now goes straight to `spawnClaude(resumeId, "resume")` without a stat check. Claude does its own check — a missing or unreadable jsonl makes claude exit before `system:init`, the bridge captures the resume failure, and the existing `RelayOutcome::ResumeFailed` path takes it terminally. Same end-to-end behavior, no false positives.
- The two tugcode tests that exercised the pre-flight (`expectedSessionJsonlPath encodes the cwd by replacing '/' with '-'` and `initialize() in 'resume' mode pre-flight rejects when claude session jsonl is missing`) are deleted. The two tests that opted out of the pre-flight via `setExistsSyncForTest(() => true)` no longer need to.

**Files touched (for reference):**

- `tugdeck/src/lib/card-services-store.ts` (new)
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (gut `useTideCardServices`; remove unused imports)
- `tugdeck/src/components/tugways/cards/use-tide-card-observer.ts` (extracted in fixup commit; unchanged here)
- `tugdeck/src/components/chrome/deck-canvas.tsx` (wire `cardServicesStore.closeCard(cardId)` before `store.handleCardClosed(cardId)`)
- `tugdeck/src/__tests__/tide-card.test.tsx` (rewrite `T-TIDE-05` for explicit close; add `T-TIDE-05b` pinning that bare unmount does NOT send close)
- `tugcode/src/session.ts` (remove pre-flight + helpers)
- `tugcode/src/__tests__/session.test.ts` (drop pre-flight tests; remove `setExistsSyncForTest` calls)

**Tradeoffs and explicit decisions:**

- **No pre-flight = ~5s wait on a genuinely-missing jsonl** (claude has to exit). Acceptable: the case is rare (user manually deleted `~/.claude/projects/...`), and the bridge's `RelayOutcome::ResumeFailed` cleanly handles it. Optimizing this back later requires either (a) passing the supervisor's canonical `workspace_key` into tugcode so the encoding matches claude's, or (b) calling `realpath` inside tugcode. (a) is cleaner; defer until a user actually complains about the wait.

**Compliance fixes (mandatory — strict tuglaws adherence per the law preamble):**

The post-implementation audit found drift in three places. The tuglaws preamble forbids silent divergence: *"Violating any law requires updating the design first — never silently diverge."* "We'll fix it later" is divergence. Each item below is a fix specification, not a deferral. If a law genuinely doesn't apply to a given site, the design (the law itself or its scope) must be updated to say so explicitly.

**CF1 — `useSyncExternalStore` for picker's tugbank-cache reads (L02).**

`TideProjectPickerForm` reads external state into React state via `useState`'s lazy-initial-value form:

```ts
const [recents] = useState<string[]>(() => {
  const client = getTugbankClient();
  return client ? readTideRecentProjects(client) : [];
});
// ... and similarly for liveSessions ...
```

L02's first sentence is unconditional: *"External state enters React through `useSyncExternalStore` only."* Lazy initial values don't carve out an exception — they're still external state being copied into React's `useState` cell.

Fix: introduce a `useTugbankValue<T>(domain, key, parse)` hook in `tugdeck/src/lib/tugbank-singleton.ts` (or a new `use-tugbank-value.ts` next to it):

- `subscribe`: registers a `client.onDomainChanged` callback, returning a cleanup that unregisters. Filtered to the matching domain so unrelated tugbank updates don't fire React re-renders.
- `getSnapshot`: reads `client.get(domain, key)` and runs `parse` on the result. Returns a reference-stable value when the underlying TaggedValue hasn't changed since the previous call (cached in a module-scope `WeakMap<TaggedValue, T>` or via a per-hook ref).

Replace both `useState` calls in `TideProjectPickerForm` with this hook. The picker is then strict-L02-compliant; if a future feature ever needs live updates while the picker is open, no rewrite is required.

**CF2 — `PromptHistoryStore` snapshot reference stability (L02).**

`createRouteProvider` and `createProvider` write `_lastActiveSessionId` without bumping `_version`. `loadSession` only bumps `_version` when `entries.length > 0`. Both break the `useSyncExternalStore` contract: snapshot reference must change when observed state changes, full stop.

Fix: **drop `_lastActiveSessionId` from the public snapshot entirely.** Verify by grep that no consumer reads `snap.sessionEntries`; if confirmed, the snapshot becomes `{ totalEntries }` only. The store may keep `_lastActiveSessionId` as an internal field if needed for non-snapshot paths, but it is no longer part of React-visible state. `_version` then needs to bump only on actual `_sessions` content changes, which `push` and `loadSession` already do — and `loadSession` should bump on EVERY successful load completion, not only when entries arrived, so a "loaded but empty" transition is observable.

If a consumer of `sessionEntries` is found, the alternative is to bump `_version` in `createRouteProvider` / `createProvider` when `_lastActiveSessionId` actually changes. Pick one strategy; do not leave the inconsistency in place.

**CF3 — Move wire `close_session` out of deck-canvas (L10).**

`deck-canvas.tsx::handleClose` calls `cardServicesStore.closeCard(cardId)` before `store.handleCardClosed(cardId)`. The deck-canvas is card-type-agnostic per L10 (*one responsibility per layer* — DeckCanvas maps state to components; card content owns domain logic). The current code makes the deck know about a tide-specific store. The smell is contained today (Tide is the only service-bearing card) but L10 is a forcing function for clean layering, not a guideline for "when convenient."

Fix: `CardServicesStore` subscribes to `DeckManager` at init time. The store maintains a snapshot of the current card-id set and runs a reconcile pass on every deck-state change. When a `cardId` transitions from "present in deck" to "absent from deck" AND a binding exists for that `cardId`, the store sends `close_session` (which clears the binding, which triggers the existing binding-reconcile path that disposes services). Remove the `cardServicesStore.closeCard` call and its import from `deck-canvas.tsx`; restore `handleClose` to the card-type-agnostic shape (`store.handleCardClosed(cardState.id)` only).

This wires the close lifecycle entirely inside the structure zone (per L24): `DeckManager` owns the layout tree, `CardServicesStore` observes layout changes that affect its own state, and acts. No cross-layer reach-in. `cardServicesStore.closeCard(cardId)` becomes an internal method of the store, not a public API the deck calls.

**CF4 — L23 enumeration of state preserved across unbind.**

L23 (*"Internal implementation operations must never lose, destroy, or cease to apply user-visible state"*) applies whenever services are disposed. The current plan does not explicitly enumerate what survives and what doesn't. Make it explicit, with rationale per item:

*Survives unbind:*

- Per-route prompt drafts — preserved via `useTugcardPersistence` → tugbank.
- Persisted prompt history for the disposed `claudeSessionId` — in tugbank under `dev.tugtool.prompt.history`.
- Recent-projects list — in tugbank under `dev.tugtool.tide / recent-projects`.
- Sessions record entry for the disposed session id — preserved on user-close so future Resume picks can still surface the session; explicitly removed only on the `resume_failed` path (which is the documented contract).

*Lost on unbind (and rationale per L23):*

- In-flight transcript in `CodeSessionStore`. **Acceptable** because every unbind path is one of: (a) user-initiated card close (transcript loss is the expected consequence of the user's gesture); (b) `resume_failed` (no transcript existed — `session_init` never arrived); (c) deck-removal of the card (semantically identical to (a)). No internal bookkeeping operation silently destroys an in-flight transcript.
- In-flight streaming text in `streamingDocument`. Same rationale.
- `TugPromptEntry.pendingHistoryPushesRef` (per-card buffer of pre-`session_init` pushes). **Acceptable** because the only unbind path that hits a non-empty buffer is `resume_failed`, where no successful `session_init` ever happened; the buffer's purpose is to flush on `session_init`, and a failed bind means the buffer's contents would have no valid session id to flush under. The user-close path always succeeds the buffer flush first (close happens after submit, which has already put the entry into the persisted history PUT path).

L23 contract going forward: any future code path that introduces a service unbind for a reason NOT in the above list must add an entry with explicit rationale, OR introduce a state-preservation mechanism for the affected user-visible state.

**Verification of compliance fixes:**

- `bun x tsc --noEmit` clean. `bun test` green. `cargo nextest run -p tugcast` green.
- New unit tests:
  - `useTugbankValue` hook test: subscribe + snapshot stability + reference change on update.
  - `PromptHistoryStore` snapshot test: pin that snapshot reference is stable until `_version` bumps, and that every state change bumps `_version`.
  - `CardServicesStore` test: simulate deck-manager card removal, assert `close_session` frame sent.
- Existing tests stay green; the deck-canvas `handleClose` test (or its equivalent) is updated to reflect the layered close.

**Verification:**

- `bun x tsc --noEmit` clean. `bun test` green (tugdeck 2128, tugcode 187 after pre-flight tests removed). `cargo nextest run -p tugcast` green (445).
- Manual smoke (the load-bearing test):
  1. Open a Tide card on `/u/src/tugtool` (or any project accessed via a symlink). Pick Start fresh. Type and submit `> remember my favorite color is purple.`. Wait for the response.
  2. Close the card. Open a new Tide card on the same path. The picker should offer Resume last session. Pick it. Click Open.
  3. The card should bind under the same `claude_session_id`. The picker should NOT reappear.
  4. Press arrow-up in the prompt entry. The previous prompt (`remember my favorite color is purple.`) should be restored into the editor.
  5. Submit `> what did I tell you to remember?`. Claude should respond with "purple" — confirming the resume actually reattached to the on-disk session.
- Session-lifecycle log scan: between `spawn.ack` and any later events, there should be NO `close.frame_send` for that card unless the user explicitly closes it.

**Out of scope:**

- The mild `PromptHistoryStore` gaps (5.6 §3 and §4 above). Document only; address in a future hygiene pass.
- Replacing the integration test mirror with the real hook (smell §5). Defer or address in [4.6](#step-4-6) when the test surface grows anyway.
- Any larger redesign of how the deck-manager and per-card stores coordinate lifecycle. The `CardServicesStore` model works; if a future card type needs different services semantics, generalize at that point.

**Tradeoff (the redirectable one):**

The decision to send `close_session` explicitly from the deck-canvas user-close handler (instead of from React's effect cleanup) is what makes the L02-compliant architecture work. The cost: any future code path that wants the card to close cleanly must call `cardServicesStore.closeCard(cardId)` before whatever else it does — there is no React-side fallback. If a future card-removal mechanism forgets, the supervisor will leak the session until the bridge crashes or the connection drops. The alternative (a cleanup that sends close on unmount) is what this step deletes; resurrecting it would re-introduce the bug class. Document the contract; don't reverse it.

#### Step 4.6 — Tugcast-side session ledger + full resume UX (placeholder; design before implementation) {#step-4-6}

**Status:** Design sketch only. Do NOT start implementation from these notes — they capture intent, not a landable plan. Promote to a full step (files, work, verification) after [Step 4.5](#step-4-5) ships, so the plumbing already in place (`sessionMode`, `resume_failed`, the picker list shape) is concrete before the richer UX and storage redesign are scoped.

**Why this exists:** [4.5](#step-4-5) wires the user-facing choice but keeps storage inside the tugbank map — one id per workspace, no metadata, no branching. That is enough to make resume *work*; it is not enough to make it *right*. Users will hit every one of these the moment 4.5 lands:

- "I have three sessions going in this repo — which one am I resuming?"
- "I closed a card; did that throw away my session?"
- "Two cards both resumed the same session — now the JSONL is corrupt."
- "I want to forget one specific session without forgetting all of them."
- "The resume timestamp is opaque; I want to see what the conversation was about."

4.6 addresses all of these by moving session bookkeeping out of tugbank and into a purpose-built tugcast-side ledger, and by reshaping the picker around the richer data the ledger exposes.

**Why a tugcast-side ledger (not tugbank):**
- Row-level queries with ordering: N sessions per workspace, sorted by `last_used_at`, filtered by state, keyed on `workspace_key`. Tugbank is a KV store; modelling this as JSON blobs would push all the logic into the reader and re-parse on every picker paint.
- Write volume: the ledger updates on every `turn_complete` frame (to tick `turn_count` and `last_used_at`), plus on every `spawn_session_ok` / `close_session` / `resume_failed`. Tugbank is not built for that cadence and the churn would pollute its change-notification stream.
- Ownership: the ledger is tugcast-process-local state about tugcast-managed child processes. It has no meaning outside tugcast; routing it through tugbank spreads responsibility across a boundary that doesn't carry its weight.
- Lifecycle: migration from 4.5's tugbank map is one-shot (read once, synthesize rows, delete the tugbank key). After migration, tugbank has no role in session bookkeeping.

**Sketch of the ledger:**
- Location: `tugrust/crates/tugcast/src/session_ledger.rs`, owned by the tugcast process. A single `SessionLedger` instance lives on the server, shared by the supervisor and the CONTROL handler.
- Storage backing: preferred **`rusqlite` with a single-file database** under the user's data dir (`~/Library/Application Support/Tug/sessions.db` on macOS, `$XDG_DATA_HOME/tugcast/sessions.db` on Linux). Sqlite carries its weight because row-level queries with `ORDER BY last_used_at DESC` and concurrent reads while the supervisor writes are exactly what it's for. Alternative considered: JSONL per workspace. Cheaper to introduce, O(N) to query, no index, worse eviction. The promotion pass picks one; sqlite is the starting preference.
- Schema (sqlite sketch):
  ```sql
  CREATE TABLE sessions (
    session_id        TEXT PRIMARY KEY,
    workspace_key     TEXT NOT NULL,
    project_dir       TEXT NOT NULL,
    created_at        INTEGER NOT NULL,  -- unix millis
    last_used_at      INTEGER NOT NULL,
    turn_count        INTEGER NOT NULL DEFAULT 0,
    first_user_prompt TEXT,              -- first user_message, truncated to 256 chars
    state             TEXT NOT NULL,     -- "live" | "closed" | "failed"
    card_id_live      TEXT               -- set while a card is bound; NULL otherwise
  );
  CREATE INDEX sessions_workspace ON sessions(workspace_key, last_used_at DESC);
  ```
- Ledger writes (driven by tugcast's supervisor, not tugcode):
  - On `spawn_session_ok`: `INSERT OR IGNORE`; set `state="live"`, `card_id_live=<card_id>`, `created_at=now`, `last_used_at=now`.
  - On first `user_message` of a session: `UPDATE first_user_prompt` (only if NULL) with the trimmed body.
  - On every `turn_complete`: `UPDATE turn_count = turn_count + 1, last_used_at = now`.
  - On `close_session` / tugcode exit: `UPDATE state="closed", card_id_live=NULL`.
  - On `resume_failed`: `UPDATE state="failed"` (ledger retains the crumb for diagnostics; Forget is the only path to full deletion).

**CONTROL protocol additions:**
- `list_sessions { workspace_key }` → `{ sessions: [{ session_id, created_at, last_used_at, turn_count, first_user_prompt, state, card_id_live }, ...] }`. Picker calls on mount and on path change.
- `forget_session { session_id }` → deletes the row; kills the tugcode child if any; moves the underlying `~/.claude/projects/.../<id>.jsonl` to a trash subdir (recoverable for a week).
- `forget_workspace_sessions { workspace_key }` → batch Forget for the picker's "Forget all sessions for this workspace" button.
- `session_updated { session_id, fields... }` → broadcast on every write above; tugdeck's picker subscribes while open so turn counts tick and state indicators stay current without polling.

**Migration from 4.5:**
- On tugcast startup (one-time): read `dev.tugtool.tide / session-id-by-workspace` from tugbank, synthesize ledger rows (`state="closed"`, metadata defaulted), delete the tugbank key. Guard against partial failures with a single transaction.
- tugcode stops reading/writing the tugbank map. The preferred shape: tugcast resolves the session id *before* spawning tugcode and passes it as a `--resume-session-id <id>` flag, so tugcode is entirely free of session bookkeeping. The alternative — tugcode calls out to tugcast over CONTROL for the id — keeps tugcode closer to its current shape but adds a round-trip on every spawn. Promotion picks one.

**Sketch of the UX:**
- Picker reshaped around the ledger's richer rows:
  - Path input (unchanged).
  - "Start fresh" row, always first.
  - N "Resume session" rows, one per ledger entry for the typed workspace, ordered by `last_used_at DESC`. Each row shows: first_user_prompt snippet (or "No prompts yet" for empty sessions), turn count, relative timestamp ("2h ago"), and a state indicator. Rows with `state="failed"` render greyed with a diagnostic subtitle.
  - Per-row "Forget" action (disabled when `card_id_live` is set). A confirmation sheet warns before deletion — this is destructive and user-visible.
  - A footer "Forget all sessions for this workspace" button.
- Live updates: picker subscribes to `session_updated` broadcasts while open. Turn counts and state change in place; no flash, no re-mount.
- Keyboard: arrow keys navigate the whole list (Start fresh + all resume rows); Enter submits; Backspace on a row triggers Forget (with confirmation sheet).
- Still no proper table component. The row shape is richer than 4.5's radio group; if a table primitive lands in tugdeck between 4.5 and 4.6, reshape accordingly, but do **not** detour to build one inside this step. The list-with-rich-rows shape is sufficient for the session counts we expect (tens, not hundreds).

**Lifecycle policies (decidable with ledger in hand):**
- **Close semantics.** Closing a card sets `state="closed"`, `card_id_live=NULL`. Metadata preserved. Next card can resume. Explicit Forget is the only path to deletion.
- **Concurrent-resume collision.** Picker greys out resume rows with `card_id_live != null && card_id_live != this.cardId`. Defense in depth: the CONTROL `spawn_session` handler in tugcast rejects `session_mode="resume"` with `session_id` already live on another card, returning `spawn_session_err { reason: "session_live_elsewhere" }`.
- **Eviction.** Ledger cap: named constant `TIDE_LEDGER_MAX_PER_WORKSPACE` (initial: 20). On spawn, if the workspace has ≥ cap rows, evict the oldest `state="closed"` row by `last_used_at`. Age-based expiry: rows older than a named `TIDE_LEDGER_MAX_AGE` (initial: 90 days) with `state != "live"` evicted on startup. Both thresholds are named constants, not magic numbers. `state="live"` rows are never evicted.
- **Recents↔ledger coherence.** When a recent-projects entry is evicted (per [4m](#step-4m)'s cap), evict all ledger rows for that workspace in the same transaction. The reverse — ledger eviction triggering recents eviction — is **not** automatic; a workspace with no stored sessions can still be a recent project.
- **Explicit Forget.** Per-row Forget + per-workspace Forget-all, each with confirmation. Forget moves the session JSONL to a trash subdir (not `rm`), keyed on delete date, swept on a coarse schedule (weekly) or next startup if older than 7 days.

**Non-goals even for 4.6:**
- Server-side archival or search across prior sessions — requires an external index, out of this plan's scope.
- Cross-machine sync — the ledger is tugcast-process-local, backed by a single file in the user's data dir.
- Session branching ("fork from turn N") — that is a Claude-side feature, not a picker UX.
- A purpose-built table / grid component for the session list. If one lands upstream, reshape; otherwise stick with the list.

**Open design questions for the promotion pass:**
- Sqlite vs JSONL backing. Starting preference: sqlite.
- Whether tugcode reads the ledger via CONTROL round-trip, or tugcast resolves the id and passes it as a CLI flag. Starting preference: CLI flag (keeps tugcode stateless).
- Whether `resume_failed` downgrades ledger state to `"failed"` (crumb for diagnostics) or deletes outright. Starting preference: `"failed"`.
- Whether the ledger also tracks assistant response bytes / storage pressure for a future "trim old sessions" UX.
- Whether any of [4m](#step-4m)'s recent-projects logic should move into the ledger itself (one store, two views) or stay separate (tugbank stays the source of truth for recents). Starting preference: keep separate — recents and sessions are different entities with different eviction policies.
- Trash sweep cadence: on-demand during Forget, or background on tugcast startup? Starting preference: startup sweep of anything > 7 days old.

#### Step 5 — Wire `TugMarkdownView` to streaming output {#step-5}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx`.
- `tugdeck/src/components/tugways/cards/tide-card.css`.

**The single seam:**

In `TideCardBody` (`tide-card.tsx:827-829`), the top split-panel currently holds an empty placeholder:

```jsx
<TugSplitPanel id="tide-card-top" defaultSize="70%" minSize="10%">
  <div className="tide-card-placeholder" aria-hidden="true" />
</TugSplitPanel>
```

Replace the placeholder `<div>` with `<TugMarkdownView>` bound to the `CodeSessionStore`'s `streamingDocument` + the `inflight.assistant` path.

**Resolved: which store, which path?**

- **Instance**: `codeSessionStore.streamingDocument` (a `PropertyStore`, exposed as a public class property — *not* on the snapshot). See [tide.md line 2406](./tide.md#code-session-store).
- **Path strings**: on the snapshot as `snap.streamingPaths.{assistant|thinking|tools}` (stable constant `STREAMING_PATHS` from `tugdeck/src/lib/code-session-store/types.ts`).
- For Step 5's top pane, use `streamingPaths.assistant` (→ `"inflight.assistant"`). Thinking and tools are separate concerns; the spec names only assistant text.

(The prior inline snippet in this step referenced a `streamingStore` string on the snapshot — an imprecision. The authoritative shape is tide.md's: `PropertyStore` instance + path string.)

**Work:**

- `tide-card.tsx`:
  - Add import: `import { TugMarkdownView } from "../tug-markdown-view";`
  - In `TideCardBody`, read the snapshot via `useSyncExternalStore(codeSessionStore.subscribe, codeSessionStore.getSnapshot)` to get `streamingPaths`.
  - Replace the placeholder JSX with:
    ```jsx
    <TugMarkdownView
      className="tide-card-stream"
      streamingStore={codeSessionStore.streamingDocument}
      streamingPath={codeSnap.streamingPaths.assistant}
    />
    ```
- `tide-card.css`:
  - Rename `.tide-card-placeholder` → `.tide-card-stream` (same `height:100%; width:100%`). `TugMarkdownView`'s root is a scroll container that requires a parent-supplied height (per `tug-markdown-view.css` comment: "Height must be set by the parent or via a className override."). The existing `100%/100%` rule is exactly what we need.

**Behavioral notes (for verification):**

- **Streaming accumulates**: the store writes `inflight.assistant` on every `assistant_text` delta via `processEffects`/`write-inflight` in `code-session-store.ts`. The observer in `tug-markdown-view.tsx` fires on each write and calls `doSetRegion('stream', text)`.
- **Turn complete (success)**: `clear-inflight` writes empty strings. The observer's `if (!text) return` short-circuits empty — **the view keeps showing the last turn's final text** until the next turn replaces it. Acceptable for Step 5; transcript display is out of scope.
- **Turn complete (error/interrupted)**: same clear path; last partial stays visible.
- **Cross-turn**: a new `assistant_text` delta replaces the `stream` region text (via `setRegion` with the same key). Users see the new turn immediately on first token.

**Tests (risk surface):**

- Existing `tugdeck/src/__tests__/tide-card.test.tsx` (T-TIDE-02/03/05/06/07) mounts the bound body; that path will now mount `TugMarkdownView`.
- `TugMarkdownView`'s module import doesn't call wasm. Its mount effects (ResizeObserver, SmartScroll, streaming `observe`) don't call `lex_blocks` until a non-empty string is written to the observed path — which these tests never do. Existing tests should keep passing with no wasm-init changes.
- **Fallback**: if a test fails on import or mount, add a module mock for `@/components/tugways/tug-markdown-view` in the test file returning a stub component.

**Verification:**
- Manual: a streaming `assistant_text` turn renders as live deltas in the top pane; `turn_complete(success)` finalizes the rendered text.
- `bun run audit:tokens lint` clean.
- `bun test tide-card` passes unchanged.

**Out of scope (to stay focused):**
- Transcript rendering in the top pane.
- Thinking / tool surfaces.
- Styling the rendered markdown to look good (polish phasing in tide.md).
- Clearing the view on `turn_complete`. The "sticky last turn" behavior is a feature for this step.
- The stale `"Project path /gallery/demo"` literal in `statusContent`.

#### Step 6 — `lastError` affordance {#step-6}

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx`.
- `tugdeck/src/components/tugways/cards/tide-card.css`.

**Work:**
- Read `snap.lastError` from the `CodeSessionStore` snapshot.
- Surface it visibly. Recommended: a thin banner above the entry (full-width, dismissable), or a status-row badge with the error category. Pick the one that requires the least new component machinery.
- The store already clears `lastError` on the next successful `send()`; the UI follows the snapshot.

**Verification:**
- Force an error (e.g., bad project_dir → `spawn_session_err`); the affordance appears.
- Submit a valid prompt; the affordance clears.
- Test asserts the affordance appears when `lastError !== null` and disappears when it clears.

#### Step 7 — W3.b: delete bootstrap workspace + `--source-tree` {#step-7}

**Files (Rust):**
- `tugrust/crates/tugcast/src/cli.rs` (or wherever the `--source-tree` flag is parsed): delete the flag and any associated arg struct field.
- `tugrust/crates/tugcast/src/server.rs` (and call sites): drop the `source_tree` parameter from function signatures.
- The bootstrap call: delete `registry.get_or_create(&watch_dir, cancel.clone())` and the `bootstrap.fs_watch_rx` plumbing it feeds.
- `tugrust/crates/tugcast/tests/`: rewrite tests that depended on the bootstrap workspace to call `spawn_session` explicitly, or delete them if Step 4's card-mount integration test covers the same surface.

**Files (docs/scripts):**
- README, `tugtool worktree setup` scaffolding, any developer setup notes that mention `--source-tree`. Per [tide.md line 2216](./tide.md#t3-workspace-registry-w3a), full deletion happens here.

**Work:**
- Delete the bootstrap surface in one coherent commit. The Tide card's `spawn_session` flow is now the only way workspace frames get published.
- Daily dev workflow: developers open tugdeck; if no card has bound a session yet, the existing git/filetree cards subscribe to feeds that have no publisher. That's the regression window — closed by also opening a Tide card with a project path. (Pre-P2: the first Tide card opened serves as the de facto bootstrap for any other card subscribing to FILETREE / FILESYSTEM / GIT.)

**Verification:**
- `rg --source-tree tugrust/` returns zero matches.
- `cargo nextest run` exits 0 across the workspace.
- Manual: launch `tugcast` without flags; confirm it starts cleanly with no bootstrap-workspace log noise; confirm a Tide card mount drives the first `spawn_session` end-to-end.

**Coupling note:** Steps 1–6 land independently if T3.4.c needs to ship in a form that *doesn't* also delete the bootstrap. Per the roadmap, they ship together. If the gate slips, this step can split off into an immediate follow-up commit per [tide.md line 2268](./tide.md#t3-workspace-registry-w3b).

#### Step 8 — Manual A/B smoke + closing checkpoints {#step-8}

**Work:**
- This is the deferred Step 8 from W2: open a Tide card pointed at project A, open a second pointed at project B, send a prompt in each, verify each card's FILETREE / FILESYSTEM / GIT feeds carry only that workspace's frames. (Nothing gates the second card — the pre-P2 shim originally scoped as [4l](#step-4l) was dropped.)
- Capture a session trace (`tugcast` log + tugdeck console) showing distinct `workspace_key` filtering.
- Close out [tugplan-workspace-registry-w2.md `#exit-criteria`](./archive/tugplan-workspace-registry-w2.md#exit-criteria) — the "deferred to T3.4.c" criterion is now satisfied.
- Close out the [T3.4.c exit criteria](#success-criteria) above by spot-checking each gallery-card feature in the Tide card.

**Verification:**
- All test suites green.
- A session trace recorded showing two cards, two `workspace_key`s, two distinct frame streams.
- `dash/tugplan-workspace-registry-w2.md` updated (move from `dash/archive/` if needed and check off the deferred criterion).

##### Tuglaws walkthrough (closing record) {#tuglaws-walkthrough}

**Walked:** `tide-card.tsx` (HEAD), `tide-card.css`, `useTideCardObserver`, `useTideCardServices` (co-located in `tide-card.tsx`), `card-services-store.ts`, `card-session-binding-store.ts`, `picker-notice-store.ts`, `completion-providers/position-zero.ts`.

**Scope:** 24 laws walked. Each is tagged *satisfied*, *N/A*, or *satisfied with follow-up*. No material violations.

**Rendering Discipline**
- **L01 — One `root.render()`, at mount, ever.** N/A. Card body composed by TugCard; no render-root calls.
- **L02 — External state via `useSyncExternalStore` only.** Satisfied. Every external source (`cardServicesStore`, `codeSessionStore`, `editorStore`, tugbank-backed recents/sessions/live-sessions) enters via `useSyncExternalStore` or `useTugbankValue`. The earlier `useState + useLayoutEffect(binding → services)` violation pre-filed by the plan is resolved — services now live in `cardServicesStore` and React only reads. See `useTideCardServices` (tide-card.tsx:202) and `CardServicesStore._construct` / `_dispose`.
- **L03 — `useLayoutEffect` for event-dependent registrations.** Satisfied. Every registration-flavored effect uses `useLayoutEffect`: picker sheet show (tide-card.tsx:316), picker session-mode cleanup (tide-card.tsx:564), editor bind (tide-card.tsx:755), maximize panel sizing (tide-card.tsx:789), observer subscribe (use-tide-card-observer.ts:29).
- **L04 — No inline child-DOM measurement after parent-triggered child setState.** Satisfied. No such pattern in walked files. `useContentDrivenPanelSize` delegates to a separate hook that (by name and prior review) follows the ready-callback pattern.
- **L05 — No `requestAnimationFrame` for operations depending on React commits.** N/A. No `requestAnimationFrame` usage in the walked files.

**State and Mutation Zones**
- **L24 — Zones: appearance / local data / structure.** Satisfied. Structure zone → `cardServicesStore`, `cardSessionBindingStore`, `pickerNoticeStore`, `codeSessionStore`, `editorStore`, `sessionMetadataStore`. Local data → `path`, `sessionMode`, `maximized`, `dismissedAt`. Appearance-only → none required; all visual state derives from data. `maximized` and `dismissedAt` are borderline (each gates UI visibility) but both represent user gestures with semantic meaning, so data-zone is correct.
- **L06 — Appearance state via CSS/DOM.** Satisfied. Banner visibility, `sessionErrored`-driven `disabled`, and `maximized`-driven behavior all derive from data (lastError, user gesture), not stored as separate appearance state. Motion owned by TugCardBanner / TugSheet / TugSplitPane internals.
- **L07 — Action handlers read via refs or stable singletons.** Satisfied. Responder-chain handlers (`useResponderForm` in picker and body) read through stable singletons — `setSessionMode` (React setter, stable), `editorStore.set(...)` (stable singleton from services). `submit` in picker form is a React `onClick` handler, not a chain-registered action, so L07 does not bind.
- **L22 — Store observers drive DOM directly.** Satisfied. `useTideCardObserver` subscribes inside `useLayoutEffect` and performs non-rendering side effects (picker-notice set + binding clear) without round-tripping through React state. `editorStore.bind(el, regenerateAtoms)` drives CSS variable updates on the pane element directly.
- **L08 — Live-preview mutation transactions.** N/A. No draft/commit/cancel UX in this card; font/size/tracking/leading popups, path input, session-mode radio, and split-pane resize are all continuous-commit interactions.
- **L23 — Preserve user-visible state.** Satisfied. Scroll (markdown pane), selection (editor), and per-route drafts (prompt entry) are each owned by their respective child components and untouched by tide-card logic. Maximize restore goes through `panel.restoreUserSize` so the user-resolved size is preserved across toggle. The 4i-era bug where services tearing down sent a stray `close_session` mid-conversation is fixed by the `cardServicesStore` refactor.

**Component Architecture**
- **L19 — Component authoring guide.** *Satisfied with follow-up.* Module docstring ✓, props JSDoc ✓, CSS `@tug-renders-on` coverage ✓ (audit:tokens lint green). **Gap:** `TideCardBody`'s root (`.tide-card` div at tide-card.tsx:872) and `TideProjectPicker`'s root lack a `data-slot` attribute. `git-card` uses `data-slot="git-card"` on its roots; tide inherited the gallery-prompt-entry omission verbatim. See follow-up #2 below.
- **L09 — Tugcard composes chrome; CardFrame owns geometry.** Satisfied. No position/size/z-index set on the card body.
- **L10 — One responsibility per layer.** Satisfied. `cardServicesStore.attachDeckManager` is the one cross-layer seam and is explicitly justified in its own JSDoc as preserving layer separation.
- **L11 — Controls emit actions; responders own state.** Satisfied. TugRadioGroup / TugPopupButton / TugPushButton dispatch actions; responders (picker form, body) register handlers via `useResponderForm` and own the state those actions mutate.
- **L12 — Selection stays inside card boundaries.** N/A. Selection-boundary registration is the TugCard layer's concern, not card-content.

**Motion**
- **L13 — CSS / TugAnimator / RAF boundaries.** Satisfied. TugSplitPanel's animated resize uses its own WAAPI layer; TugSheet uses Radix + CSS keyframes; TugCardBanner uses TugAnimator. No bespoke RAF animation in the card. TugSplitPane's internal RAF (if any) is gesture-driven drag — the L13-sanctioned use.
- **L14 — Radix Presence vs TugAnimator boundary.** Satisfied. Radix Presence owns the sheet's enter/exit; TugAnimator owns the banner's. The card body does not cross between.

**Token System**
- **L15 — Token-driven control states.** Satisfied. The card composes token-driven controls (TugInput, TugRadioGroup, TugPushButton, TugPopupButton, TugBadge, TugBox); `tide-card.css` defines no interactive control styles of its own.
- **L16 — `@tug-renders-on` on color-setting rules.** Satisfied. Every color-setting rule without a paired background carries `@tug-renders-on`. `bun run audit:tokens lint` is green.
- **L17 — Alias tokens resolve in one hop.** N/A. `tide-card.css` declares no `--tugx-*` component aliases.
- **L18 — Element / surface vocabulary.** Satisfied. Element tokens (`--tug7-element-global-text-*`) used for color; one `--tug7-element-global-surface-attention-muted-rest` used for the picker-notice background — accepted by `audit:tokens lint`.

**Composition**
- **L20 — Tokens scoped to own component slot.** Satisfied. Card-level CSS references only global design tokens and global-scope element tokens; no reach into composed-child component slots.

**Licensing**
- **L21 — Third-party licensing.** N/A. No third-party code in the walked files.

**Outstanding follow-ups (non-blocking)**

1. **Render-time `pickerNoticeStore.consume` in `TideProjectPicker`** (tide-card.tsx:311–314). The picker primes `noticeRef.current = pickerNoticeStore.consume(cardId)` inside the render body — a side-effectful read during render. It works in practice under React 18 StrictMode (the ref is stable across the discard-then-commit pair), but violates the "render must be pure" principle. Cleaner as `useMemo(() => pickerNoticeStore.consume(cardId), [cardId])` or a `useLayoutEffect`-gated consumption stored in a small useState. This is the direct descendant of the `if (ref.current === null) ref.current = new X()` pattern the plan pre-filed for cleanup. Low-priority.
2. ~~**Missing `data-slot` attributes.** Add `data-slot="tide-card"` on `TideCardBody`'s root div (tide-card.tsx:872) and `data-slot="tide-card-picker"` on `TideProjectPicker`'s root div (tide-card.tsx:359–366) to match the `git-card` convention. One-line fix each.~~ **Done** — `data-slot="tide-card"` and `data-slot="tide-card-picker"` added; typecheck + tests green.

**Summary.** 24 laws walked. 17 satisfied, 5 N/A, 2 satisfied with minor follow-ups (L19 `data-slot`, L02/L24-adjacent `noticeRef` render-time read). No material violations. The plan's pre-filed concerns about services lifecycle have been resolved by the `cardServicesStore` refactor.

---

### Risks {#risks}

**R1 — Hidden coupling in the gallery card.** The gallery card has accumulated subtle wiring (mock connection refs, fixture-data side effects, timing-sensitive useLayoutEffect ordering). The "copy then substitute" approach minimizes this risk because the structural skeleton is unchanged, but a careful diff in Step 1 vs. Step 4 is essential. Keep substitutions small per commit so any regression is bisectable to a single seam swap.

**R2 — Bootstrap removal regression window.** If Step 7 lands but a developer opens tugdeck without ever opening a Tide card, the existing git/filetree cards display empty `Loading...` placeholders. Document this in the README change in Step 7 — "open a Tide card to populate workspace feeds" replaces "tugcast --source-tree=..." in setup docs. Acceptable because Tug.app shipping users always run via the Tide card path; the regression only touches dev tooling.

**R3 — ~~Single-session shim ambiguity~~ (resolved).** Originally this risk debated whether a second Tide card should (a) share the default session with a visible indicator or (b) be blocked outright. Resolved during [4k](#step-4k): each card gets its own fresh claude session, so neither branch applies — the second card is neither shared nor blocked, it simply stands on its own. The shim originally scoped as [4l](#step-4l) was dropped; see that sub-step's tombstone. The resume-vs-new UX question (how the user opts *into* resuming a prior session) is carried forward to [Step 4.5](#step-4-5).

**R4 — `lastError` affordance design churn.** Banner vs badge vs inline message — easy to bikeshed. Pick the simplest (banner above entry, dismissable) and ship it; revisit in T3.4.d if the choice doesn't survive contact with real Claude error rates.

**R5 — Project picker visual quality.** Text input + button is ugly but functional. Per the [Scope](#scope), file-picker UX is T3.4.d. Don't let polish creep in here — Step 4 ships the minimum, T3.4.d makes it pretty.

**R6 — Atom font embedding fallback uncertainty.** WebKit data-URI SVG `@font-face` loading was implemented but not 100% confirmed working in production. If atoms render in fallback monospace under live conditions, that's a visual polish issue, not a T3.4.c blocker — file it for T3.4.d.

**R7 — `cargo nextest` test rewrites in Step 7.** The bootstrap-related test cleanup may surface test-only assumptions (e.g., a test that assumes `watch_dir` is always set). Budget for an afternoon of test triage; if more than one full day, split Step 7 to its own follow-up commit per the coupling note above.

---

### Resolved Decisions {#resolved-decisions}

These were the open questions surfaced when the plan was drafted. All are now answered. Anything that affects implementation has been propagated into [Strategy](#strategy), [Scope](#scope), or the relevant [Step](#steps).

**D1 — Picker UI shape: text input only.** No native dialog or "Browse…" affordance in T3.4.c. A bridge to the host file picker is T3.4.d polish if it ever happens.

**D2 — Recent-projects list: yes, soft requirement.** Persist the last N (≈5) chosen paths in tugbank and surface them as quick-pick buttons in the picker. Nice to have but not gating — if it slips, ship without it and add in T3.4.d. Moved into [Scope](#scope) as a soft requirement; called out in [Step 4](#step-4).

**D3 — Picker placement: always shown when unbound.** A Tide card without a `project_dir` makes no sense — there is nothing for it to do. The picker is the entire card body until bound; once bound it disappears entirely. No split-pane placeholder underneath, no compact status-row form. Reflected in [Step 4](#step-4).

**D4 — Re-bind affordance: none.** Opening a new card is the gesture for re-pointing at a different project. Closing and reopening is two clicks. Defer the in-card re-bind until users specifically ask.

**D5 — Maximize state across project changes: simplest path wins.** Current implementation (`useTugcardPersistence` round-trip via `onMaximizeChange`) inherits unchanged from the gallery copy. Don't redesign it for the Tide card; verify it round-trips during [Step 8](#step-8) and refine later if the behavior surfaces a real problem.

**D6 — `gallery-prompt-entry` is preserved verbatim.** The gallery card stays exactly as it is now — same file path, same content, same registration, same purpose (theme-audit and visual regression on the bare component-in-card shape with no live dependencies). The Tide card is a *copy*, not a replacement. No edits to `gallery-prompt-entry.tsx` or `gallery-prompt-entry.css` should appear in any commit on this plan.

---

### References {#references}

- Roadmap anchor: [tide.md §T3.4.c](./tide.md#t3-4-c-tide-card)
- Predecessor: [tide.md §T3.4.b](./tide.md#t3-4-b-prompt-entry) (✓ landed)
- Riding alongside: [tide.md §T3.0.W3.b](./tide.md#t3-workspace-registry-w3b)
- Closes deferred criterion in: [archive/tugplan-workspace-registry-w2.md](./archive/tugplan-workspace-registry-w2.md)
- Decision references: D-T3-04 (gallery card override — already moot per T3.4.b plan), D-T3-09 (one CodeSessionStore per card), D-T3-10 (no IndexedDB), D-T3-11 (shared observer rehydration)
- Commits accumulated since T3.4.b landed (the polish baseline that ships in the Tide card):
  - `de99a556` Lock T3.4.c baseline to copy of gallery prompt entry
  - `57a25e47` Accept > as alias for ❯ prompt route prefix
  - `29127a77` Move maximize toggle next to settings gear
  - `d12429ca` Stand down content sizers while maximize is on
  - `01308ce2` Add maximize toggle to prompt entry
  - `02bf55e4` Add Tracking and Leading editor controls
  - `254e53dd` Scale atom label to 0.96x of editor size
  - `7cefe36f` Embed @font-face fonts in atom SVGs and purge route atom code
  - `a047adff` Match atom font size to editor and align baselines
  - `992b58c9` Sanitize clipboard HTML on atom paste
  - `69ad9de8` Render route prefix as text in gutter and choice group
