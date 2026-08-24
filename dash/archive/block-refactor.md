<!-- devise-skeleton v4 -->

## Block Renderer Generalization — from ToolBlock to Block {#block-refactor}

**Purpose:** Promote the tool-block renderer system into a general **block** renderer system — one `BlockChrome` contract with a small set of content **variants** (`tool` / `receipt` / `note` / `data`) — so the git-commit receipt, markdown tables, and the assistant Thinking block stop being one-off chromes that borrow or re-implement the frame. No blocks left behind.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-20 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The tool-block renderers are good — but their features accreted stepwise, and everything is *named and scoped as if tool calls were the only citizen*. The cost shows up whenever a frame-level change lands: "core facility is in place, now the 17 (really 20) consumers…". Worse, three non-tool surfaces already lean on the same frame three *different* ways: the git-commit **receipt** is a body-kind composed inside `ToolBlockChrome`; **markdown tables** re-implement the chrome imperatively in the DOM (because they are `innerHTML`, not React); the assistant **Thinking** block owns a wholly separate chrome with its own `--tugx-thinking-*` tokens.

The generalization is already *half-done and half-named*: the shared surface tokens are `--tugx-block-*` (consumed by both the React chrome and the markdown-table DOM chrome), and the affordance primitives are already `BlockCopyButton` / `BlockFoldCue` / `BlockActionsCluster`. What is still tool-shaped is the chrome component itself (`ToolBlockChrome`), the header (`ToolCallHeader`), the directory (`tool-blocks/`), the helper bits (`body-bits/`), and the `--tugx-toolblock-*` status token family. This plan finishes the convergence the codebase already started, then introduces a `variant` axis and migrates the three borrowers onto it.

#### Strategy {#strategy}

- **Rename on a clean base first.** Land the mechanical `ToolBlock → Block` rename + token convergence as behavior-preserving steps, gated by `tsc` and the data-slot app-tests, before any visual work. The `tool` variant must render pixel-identically to today at the end of the rename.
- **Introduce `variant` as an additive axis.** `variant?: "tool" | "receipt" | "note" | "data"`, default `"tool"`. Variant appearance is CSS-token-scoped via `[data-variant]` per [L06]/[L20] — never a component fork. Default keeps the post-rename render unchanged until a caller opts in.
- **Migrate the borrowers one at a time, each shippable.** Thinking → `note`, commit receipt → `receipt`, markdown tables → `data` (DOM substrate). Each migration is its own step with its own checkpoint; an integration step verifies they coexist.
- **Two substrates, one contract.** React `BlockChrome` and the imperative-DOM `enhance-block-chrome` stay two renderers (innerHTML can't become React); the win is a single `--tugx-block-*` vocabulary and matched affordance shapes so a frame change lands in both.
- **Clear and rebuild the gallery.** Delete the 31 block-related cards; rebuild ~6 intentional cards (one per variant + a states matrix + a body-kinds card), preserving app-test fixtures.
- **Flag the two design-shaping unknowns as tracked Open Questions** ([Q01] variant API shape, [Q02] Thinking token retirement) and resolve them at the kickoff of the steps they gate.

#### Success Criteria (Measurable) {#success-criteria}

- `rg "ToolBlockChrome|ToolCallHeader" tugdeck/src` returns zero hits outside compatibility shims (if any are kept) — the base is renamed. (grep)
- `--tugx-toolblock-*` no longer appears in `tugdeck/src` or `tugdeck/styles`; the status slots live under `--tugx-block-*`. (grep)
- `bun run check` passes at every step; the data-slot app-tests pass unchanged after the rename steps (no visual regression in the `tool` variant). (`bun run check`, `just app-test`)
- `DevThinkingBlock`, `CommitBlock`, and the markdown-table chrome each render through the shared block contract: Thinking and commit via `BlockChrome` variants; tables via `enhance-block-chrome` sharing the `--tugx-block-*` family. (`rg "--tugx-thinking-"` → zero or [Q02]-deferred; code review)
- The gallery exposes exactly one card per variant plus a states matrix and a body-kinds card; the four retired-but-test-referenced fixtures still mount. (gallery boots, `just app-test`)

#### Scope {#scope}

1. Rename the React chrome + header + directory + helper bits + `--tugx-toolblock-*` token family to the `Block` vocabulary.
2. Add the `variant` axis (`tool`/`receipt`/`note`/`data`) to `BlockChrome` / `BlockHeader`, CSS-scoped via `[data-variant]`.
3. Migrate the Thinking block onto the `note` variant.
4. Migrate the git-commit receipt onto the `receipt` variant.
5. Unify the markdown-table DOM chrome (`enhance-block-chrome`) onto the shared `--tugx-block-*` contract as the `data` variant.
6. Clear and rebuild the gallery block cards (~31 → ~6), preserving app-test fixtures.
7. Update tuglaws / design-decisions references that name "tool block" as the base.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Renaming the 20 per-tool wrappers (`BashToolBlock`, `ReadToolBlock`, …). They remain consumers of the `tool` variant; "tool block" stays a meaningful term for that variant.
- Converting the markdown-table renderer from imperative DOM to React. The substrate stays; only the token/affordance contract converges.
- New body kinds, new tools, or behavior changes to existing tool rendering beyond the variant default.
- Removing IndexedDB/SessionCache or any unrelated tugdeck infra.

#### Dependencies / Prerequisites {#dependencies}

- The badge-chrome groundwork from this conversation is already committed (`875d4c43`, `5ad4c25e`) — ghost header badges + bracketed summary pipes. The rename inherits that state.
- tuglaws: [L02], [L06], [L17], [L19], [L20], [L22], [L26]; design-decisions [D05], [D14].
- HMR is live; tugdeck needs no build step. App-tests via `just app-test`.

#### Constraints {#constraints}

- **Warnings are errors** for Rust, but this is tugdeck (TS/CSS); the equivalent gate is `bun run check` (`tsc --noEmit`) passing with zero errors.
- **[L06]** appearance via attributes/CSS, never React state — the `variant` axis must be `[data-variant]` + token scoping, not conditional class trees that re-render.
- **[L20]** component-token sovereignty — `BlockChrome` owns `--tugx-block-*`; body kinds keep their own `--tugx-{kind}-*`. Variants override only within the chrome's family.
- **[L26]** mount identity is stable across collapse — the rename must not change the single-header, single-mount structure.
- No new persistence; no localStorage (per house rules). Any persisted collapse state continues through existing mechanisms.

#### Assumptions {#assumptions}

- The shared `--tugx-block-*` surface family (strip-bg, text-color, code-font, …) is the intended base and needs no rename — only `--tugx-toolblock-*` (status family) folds into it.
- The affordance primitives (`BlockCopyButton` / `BlockFoldCue` / `BlockActionsCluster`) are already general and need no rename.
- App-tests assert on `data-slot` contracts and behavior, not on emphasis classes or token names, so a token rename is invisible to them (confirmed for the badge change).
- A compatibility shim for the old `ToolBlockChrome` name is unnecessary — all callers are in-repo and renamed atomically per step.

---

### Reference and Anchor Conventions {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `**References:**` lines per the devise skeleton. Plan-local decisions are `[P01]`; global decisions are cited as `[D05]` etc.; laws as `[L20]`. Step dependencies cite `#step-N` anchors. No line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Variant API shape — single header vs thin wrappers (OPEN) {#q01-variant-api-shape}

**Question:** Is `variant` a single prop on `BlockChrome` (`variant?: "tool" | "receipt" | "note" | "data"`) with all four variants sharing one `BlockHeader`, its appearance switched purely by `[data-variant]` token scoping? Or do `note`/`data` diverge enough (e.g. `note` has no dot/verb and a prose body; `data` is DOM-substrate) to warrant a thin per-variant wrapper around a shared core?

**Why it matters:** It determines whether Step 3 ships one component with four token scopes or a small family. Guessing "single component" and discovering `note` needs a structurally different header forces a mid-migration refactor (Steps 4–6 churn). Guessing "wrappers" over-engineers the common `tool`/`receipt` case.

**Options (if known):**
- **Single `BlockChrome` + `[data-variant]` scoping** (recommended default) — one header, appearance via tokens/attributes per [L06]/[L20]. Cleanest if the structural delta between variants is "which sub-elements render", expressible by passing/omitting props (no dot for `note`, etc.).
- **Shared core + thin variant wrappers** — `BlockChrome` core plus `NoteBlock` / `ReceiptBlock` composition wrappers when a variant's structure truly diverges. The `data` (DOM) renderer is necessarily separate regardless.

**Plan to resolve:** Spike at the top of [#step-3]: prototype the `note` and `data` variants' headers against the single-component model; if either needs structure the prop surface can't express cleanly, adopt the thin-wrapper option for *that* variant only. Decide and record as a `[P##]` before completing Step 3.

**Resolution:** DECIDED (see [P07]) — spiked at [#step-3] kickoff by comparing the three header shapes in source; `note`/`data` diverge structurally, so the hybrid contract was chosen.

#### [Q02] Thinking token family — retire `--tugx-thinking-*` or keep it (OPEN) {#q02-thinking-tokens}

**Question:** When Thinking moves onto the `note` variant, do we retire the `--tugx-thinking-*` family entirely (folding its values into `--tugx-block-*` `[data-variant="note"]` scoping), or keep `--tugx-thinking-*` as the `note` variant's sovereign sub-family per [L20]?

**Why it matters:** Retiring it is the cleaner "one vocabulary" outcome and satisfies a success criterion, but Thinking's streaming binding ([L22], [D14]) and its distinct muted treatment may justify a sovereign family. Getting this wrong means either a token family that lingers against the plan's intent, or a flattening that loses the `note` look and forces a re-split.

**Options (if known):**
- **Retire into `[data-variant="note"]`** (recommended default) — `--tugx-block-*` slots overridden under the note scope; `--tugx-thinking-*` deleted from `brio.css`/`harmony.css`. Maximizes the single-vocabulary win.
- **Keep `--tugx-thinking-*` as the note sub-family** — `note` variant composes `BlockChrome` but reads `--tugx-thinking-*` for its prose/muted tones, preserving [L20] sovereignty for a genuinely distinct content type.

**Plan to resolve:** Decide at [#step-4] kickoff after the `note` variant exists; compare the two token graphs side by side in the gallery `note` card. Record as a `[P##]`.

**Resolution:** DECIDED (see [P08]) — keep `--tugx-thinking-*` as note's sub-family; ~9/12 tokens have no `--tugx-block-*` counterpart.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Rename breaks an app-test data-slot contract | med | low | Keep `data-slot` strings stable; rename symbols/tokens only | any app-test failure after a rename step |
| Variant CSS leaks across variants | med | med | Scope every variant rule under `[data-variant="…"]`; no bare overrides | visual diff in the `tool` variant after Step 3 |
| Thinking streaming binding regresses on migration | high | low | Preserve the `PropertyStore` subscription + imperative delta path verbatim ([L22]) | streaming card shows no live deltas |
| Gallery deletion drops a card an app-test mounts | med | med | Inventory test-referenced cards before deleting; preserve fixtures | `just app-test` fails to mount a gallery card |
| Markdown-table DOM chrome drifts from React chrome again | low | med | Single `--tugx-block-*` token source; document the two-renderer contract in a deep dive | a future frame change touches only one substrate |

**Risk R01: Silent visual regression in the `tool` variant** {#r01-tool-variant-regression}

- **Risk:** The rename + variant axis subtly shifts the default tool render (spacing, token resolution) without breaking tests.
- **Mitigation:** Rename steps are behavior-preserving by construction (symbol/token substitution); a gallery `tool` card and the bash mount-in-saved-state fixture are eyeballed after Step 3.
- **Residual risk:** Pixel-level drift not caught by data-slot tests; accepted, caught by HMR review.

---

### Design Decisions {#design-decisions}

#### [P01] `Block` is the base; `tool` is a variant, not the base (DECIDED) {#p01-block-is-base}

**Decision:** The base renderer is `BlockChrome` / `BlockHeader` with a `variant` axis; tool calls are the `tool` variant. The 20 per-tool wrappers keep their names and become `tool`-variant consumers.

**Rationale:**
- The frame is already content-agnostic; only its name and a token family are tool-shaped.
- Keeping wrapper names avoids a 20-file churn with no payoff and preserves "tool block" as a precise term for that variant.

**Implications:** `tool-blocks/` → `blocks/`; `ToolBlockChrome` → `BlockChrome`; `ToolCallHeader` → `BlockHeader`; `body-bits/` → `block-bits/`. Wrapper class names unchanged; their imports update to the new paths.

#### [P02] Token convergence: fold `--tugx-toolblock-*` into `--tugx-block-*` (DECIDED) {#p02-token-convergence}

**Decision:** The tool-block status token family `--tugx-toolblock-*` is renamed into the shared `--tugx-block-*` family (as status slots on the base); the shared surface family (`--tugx-block-strip-*`, `--tugx-block-text-*`, `--tugx-block-code-font`) is already correct and stays.

**Rationale:**
- One vocabulary for both substrates (React + DOM) is the core anti-accretion win.
- The shared family already exists and is consumed by markdown tables, so this completes a started convergence rather than inventing one.

**Implications:** Edits in `tool-block-chrome.css` `body{}`, `brio.css`, `harmony.css`, `tug-active-theme.css`. Variant-specific values ride `[data-variant]` scopes within `--tugx-block-*`.

#### [P03] Variant appearance is `[data-variant]` + token scoping, never a render fork (DECIDED) {#p03-variant-via-attributes}

**Decision:** `variant` stamps `data-variant="…"` on the block root; all variant-specific appearance is CSS scoped under that attribute. Structural differences (dot present, verb present, body kind) are expressed by props the variant passes, not by branching component trees that swap on state.

**Rationale:** [L06] (appearance via attributes/CSS), [L20] (token sovereignty), [L26] (stable mount identity). Keeps one mount, one header, four looks.

**Implications:** Whether a thin wrapper exists for a structurally-divergent variant is [Q01]; even with a wrapper, appearance still flows through `[data-variant]`.

#### [P04] Two substrates, one contract (DECIDED) {#p04-two-substrates}

**Decision:** Markdown tables continue to render via imperative DOM (`enhance-block-chrome`); they are the `data` variant by sharing the `--tugx-block-*` tokens and matched affordance shapes, not by becoming React.

**Rationale:** Markdown is sanitized `innerHTML`; a React port is out of scope and unnecessary. The contract (header strip, identity, fold, copy, pin-stack) is already mirrored; convergence is at the token/shape layer.

**Implications:** A deep dive documents the React↔DOM contract so future frame changes touch both. `enhance-block-chrome` stamps `data-variant="data"` for parity.

#### [P05] Gallery: clear and rebuild small (DECIDED) {#p05-gallery-rebuild}

**Decision:** Delete the 31 block-related gallery cards; rebuild ~6 — one card per variant, a states matrix (streaming/ready/error/collapsed), and a body-kinds card — preserving app-test fixtures.

**Rationale:** The existing cards demo the *old* tool-centric surface and will be superseded; a per-variant set matches the new mental model. Per the user's decision in the originating conversation.

**Implications:** Inventory `gallery-bash-mount-in-saved-state`, the markdown KB fixtures, and the transcript-copy/transcript-markdown cards for app-test references before deletion; keep what tests mount.

#### [P06] The dispatch/types contract stays `ToolBlock*` (DECIDED) {#p06-dispatch-types-stay}

**Decision:** The shared per-tool contract surface — `ToolBlockProps<TInput, TStructured>`, `ToolBlockStatus`, `ToolBlockFactory`, `NullToolBlock`, `resolveToolBlock`, `TOOL_BLOCK_REGISTRY`, `BESPOKE_FACTORY_BY_NAME`, `registerToolBlock` (in `cards/tool-blocks/types.ts` → `cards/blocks/types.ts`, and `dev-assistant-renderer-dispatch.ts`) — keeps its `ToolBlock*` naming. Only its file path moves with the directory rename.

**Rationale:**
- These types describe the **`tool` variant's** contract specifically (a wire-shape tool call → a body kind), not the general block frame. The `receipt`/`note`/`data` variants do *not* flow through this registry — they are composed directly by their owners (`DevThinkingBlock`, `CommitBlock`, `enhance-block-chrome`). Renaming them to `Block*` would wrongly imply the registry is the general dispatch path.
- Keeping the names avoids touching the 20 wrappers' prop typing for zero behavioral gain, consistent with [P01] keeping the wrapper class names.

**Implications:** Step 1 moves these symbols' file with the dir rename but does **not** rename them. The success-criteria grep targets only `ToolBlockChrome|ToolCallHeader`, so these surviving `ToolBlock*` names are expected, not a miss.

#### [P07] `variant` is a hybrid contract, not one component for all (DECIDED) {#p07-variant-hybrid-contract}

**Decision:** `variant` is a shared *contract* — the `--tugx-block-*` token scope under `[data-variant]`, the collapse/affordance shapes, and the `data-variant` attribute. `BlockChrome`/`BlockHeader` is the React implementation that renders the `tool` (default) and `receipt` variants (same dot/identity/trailing-actions header, restyled by `[data-variant]`). The `note` (Thinking) and `data` (markdown-table) variants adopt the same contract from their own roots rather than rendering through `BlockHeader`. `BlockChrome`'s `variant` prop is therefore typed `"tool" | "receipt"`; the full four-value vocabulary is exported as `BlockVariant`.

**Rationale (from the [#step-3] spike, comparing the three header shapes in source):**
- `tool` and `receipt` share one shape (dot/icon + identity + trailing actions); `receipt` only restyles + adds an accent rail — expressible as `[data-variant]` token overrides on the one `BlockHeader`.
- `note` diverges structurally: a single `<button>` header with a **leading** chevron + "Thinking" label + a collapsed **preview** line (no dot, no verb, no detail, no summary, no copy), AND a height-**animated** body (grid 0fr↔1fr) instead of the chrome's subtree mount/unmount. Forcing this through `BlockHeader`'s props would bury note-only branches in the shared component and add a second collapse path.
- `data` is a separate substrate (imperative DOM, no React `BlockHeader`) per [P04].

**Implications:** Step 3 adds `variant?: "tool" | "receipt"` + the `BlockVariant` export + the `data-variant` stamp. Step 4 keeps Thinking's bespoke header/body but adopts the `--tugx-block-*` `[data-variant="note"]` token scope + the collapse/affordance contract. Step 6's table frame stamps `data-variant="data"` and reads the shared tokens. Variant token overrides are substrate-agnostic (keyed on the attribute), so each adopter scopes its own under `[data-variant="…"]` where its tokens live.

#### [P08] `note` keeps `--tugx-thinking-*` as a sovereign sub-family (DECIDED) {#p08-keep-thinking-tokens}

**Decision:** When Thinking adopts the `note` contract, it reads the shared `--tugx-block-*` SURFACE tokens (bg / text / border / radius / margin) for its frame and stamps `data-variant="note"`, but keeps its note-specific tones in `--tugx-thinking-*` (label, preview, italic content, collapse-animation timing, focus ring). `--tugx-thinking-*` is NOT retired.

**Rationale (from inspecting the family at [#step-4] kickoff):** ~9 of the 12 `--tugx-thinking-*` tokens have no `--tugx-block-*` counterpart — the "Thinking" label, the collapsed preview line, the **italic** prose body, and the height-animation duration/easing are all note-only. Retiring them would force note-only slots (`--tugx-block-label-*`, `--tugx-block-preview-*`, `--tugx-block-content-style`, `--tugx-block-collapse-*`) into the shared family — the opposite of convergence. [L20] sovereignty says a genuinely distinct content type keeps its own sub-family.

**Implications:** Step 4 switches only Thinking's frame surface to the shared `--tugx-block-*` tokens (so a frame change lands on note) and leaves `--tugx-thinking-*` for the rest. The success criterion's `rg "--tugx-thinking-"` check resolves as DEFERRED-by-decision (kept, not zero) per this `[P08]`.

---

### Deep Dives {#deep-dives}

#### Current architecture map {#architecture-map}

**Base chrome (React):** `tugdeck/src/components/tugways/cards/tool-blocks/tool-block-chrome.tsx` → `ToolBlockChrome` composes one `ToolCallHeader` (`tool-call-header.tsx`) in every state: lifecycle dot + name + identity/command detail, a collapse-independent **notice band**, a body slot (`data-slot="tool-block-body"`), a footer, an actions-portal slot (`ChromeActionsTargetContext`), header-owned Copy + fold. Token families: shared surface `--tugx-block-*` + status `--tugx-toolblock-*` + header `--tugx-toolheader-*`.

**Consumers (20):** `bash/read/edit/glob/grep/task/ask-user-question/skill/monitor/worktree/task-mgmt/cron/share-onboarding-guide/remote-trigger/task-inline/web-fetch/web-search/write/notebook-edit/default` `*ToolBlock`, dispatched via `cards/dev-assistant-renderer-dispatch.ts` (a `Map<string, ToolBlockFactory>`; `resolveToolBlock` falls back to `DefaultToolBlock`).

**Helper bits:** `tool-blocks/body-bits/` → `ToolBlockBody`, `ToolBlockFieldRow`, `ToolBlockDisclosure`, `ToolBlockPre`.

**Affordances (already general):** `body-kinds/affordances/` → `BlockCopyButton`, `BlockFoldCue`, `BlockActionsCluster` — already `Block*`-named; no rename needed.

**Borrower 1 — commit receipt:** `body-kinds/commit-block.tsx` → `CommitBlock`, a body kind composed inside `ToolBlockChrome` when `BashToolBlock` detects `git commit`. Owns a bespoke accent-rail/graph-node.

**Borrower 2 — markdown tables:** `lib/markdown/enhance-block-chrome.ts` (+ `enhance-table.ts`) — imperative-DOM chrome built from `buildBlockHeader` / `buildCopyButton` / `buildFoldButton`, already styled off `--tugx-block-*` and joining the pin-stack like `ToolCallHeader`.

**Borrower 3 — Thinking:** `chrome/dev-thinking-block.tsx` → `DevThinkingBlock`, a wholly separate collapsible chrome (own chevron + label) wrapping `TugMarkdownBlock`; owns `--tugx-thinking-*`; streaming via `PropertyStore` ([L22]); default-collapsed-on-complete ([D14]).

**Gallery:** `cards/gallery-registrations.tsx` registers ~90 cards across 10 `CATEGORIES`; 31 live under `CATEGORIES.blockRenderers`.

#### Token taxonomy after convergence {#token-taxonomy}

**Spec S01: Block token families (post-refactor)** {#s01-block-tokens}

| Family | Owner | Status |
|---|---|---|
| `--tugx-block-strip-*`, `--tugx-block-text-*`, `--tugx-block-code-font` | shared base surface | already correct — keep |
| `--tugx-block-*` (status slots, ex-`--tugx-toolblock-*`) | `BlockChrome` base | rename target ([P02]) |
| `--tugx-toolheader-*` | `BlockHeader` layout | keep (rename only if [Q01] merges header naming) |
| `--tugx-block-*` `[data-variant="receipt"\|"note"\|"data"]` | variant scopes | new, additive ([P03]) |
| `--tugx-thinking-*` | Thinking | retire-or-keep per [Q02] |
| `--tugx-{term,diff,file,json,image}-*` | body kinds | unchanged ([L20]) |

The shared base surface family is defined in `tugdeck/styles/tugx-block.css` (the canonical block-surface scaffold per `component-authoring.md`) — *not* in the theme files. The status family being folded in ([P02]) is defined in `block-chrome.css`'s `body{}`. Both keep one-hop resolution to `--tug*` ([L17]).

#### React ↔ DOM contract (for the `data` variant) {#react-dom-contract}

Both substrates render the same visual contract: a sticky header strip (`top: var(--tugx-pin-stack-top, 0)`), an identity region, a trailing actions cluster (copy + fold), and a `data-variant` root. The React side composes `BlockHeader` + affordance components; the DOM side composes `buildBlockHeader` + `buildCopyButton` + `buildFoldButton`. The single source of truth is the `--tugx-block-*` family and the `--tug-button-xs-*` control tokens. A frame-level change (e.g. the badge/pipe work) must update both the CSS family and, if it adds structure, both builders/components.

---

### Specification {#specification}

#### Public surface — `BlockChrome` variant axis {#blockchrome-api}

**Spec S02: `variant` prop** {#s02-variant-prop}

- `variant?: "tool" | "receipt" | "note" | "data"` — default `"tool"`. Stamps `data-variant` on the root ([P03]).
- All existing `ToolBlockChromeProps` carry over under the renamed `BlockChromeProps` (toolName→`title` is *not* renamed in this plan — kept as `toolName` to avoid wrapper churn; revisit only if [Q01] restructures the header).
- `tool` default ⇒ identical render to the post-rename baseline (the 20 wrappers pass no `variant`).

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `variant` selection | structure (prop) | prop → `data-variant` attribute on root | [L06], [L20] |
| variant appearance | appearance | CSS scoped under `[data-variant]`, token overrides | [L06], [L20] |
| block collapse (existing) | appearance + structure | `ToolBlockCollapseContext` + `data-block-collapsed`; body subtree mount/unmount | [L06], [L26] |
| Thinking streaming deltas | local-data (external) | `PropertyStore` subscription, imperative DOM writes, no React state per delta | [L22] |
| Thinking collapse default | appearance | mode default → `data-collapsed`; CSS animates | [L06], [D14] |
| header-height var (existing) | appearance | `useLayoutEffect` + `ResizeObserver` writes `--tugx-block-header-height` | [L03], [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/cards/blocks/` (dir, renamed from `tool-blocks/`) | the block renderer home |
| `tugdeck/src/components/tugways/cards/gallery-block-variants.tsx` (+ `.css`) | one card demoing all four variants |
| `tugdeck/src/components/tugways/cards/gallery-block-states.tsx` (+ `.css`) | states matrix (streaming/ready/error/collapsed) |
| `tugdeck/src/components/tugways/cards/gallery-block-body-kinds.tsx` (+ `.css`) | body-kinds showcase |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `BlockChrome` | component (rename) | `blocks/block-chrome.tsx` | from `ToolBlockChrome` |
| `BlockChromeProps` | interface (rename) | `blocks/block-chrome.tsx` | adds `variant` ([S02]) |
| `BlockHeader` | component (rename) | `blocks/block-header.tsx` | from `ToolCallHeader` |
| `BlockBody`/`BlockFieldRow`/`BlockDisclosure`/`BlockPre` | components (rename) | `blocks/block-bits/` | from `ToolBlock*` body-bits |
| `--tugx-block-*` status slots | tokens (rename) | defs in `block-chrome.css` `body{}`; readers across `blocks/`, `body-kinds/{file,json-tree,diff,agent-transcript}`, `tug-markdown-view.css`; pointer comments in `brio.css`/`harmony.css`/`tug-active-theme.css` | from `--tugx-toolblock-*` ([P02]) |
| `NoteBlock` (Thinking) | component (migrate) | `chrome/dev-thinking-block.tsx` | composes `BlockChrome variant="note"` |
| `CommitBlock` | component (migrate) | `body-kinds/commit-block.tsx` | `variant="receipt"` treatment |
| `enhance-block-chrome` | module (extend) | `lib/markdown/enhance-block-chrome.ts` | stamps `data-variant="data"` |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Drift Prevention** | `bun run check` + data-slot app-tests prove the rename is behavior-preserving | every rename step |
| **Integration (app-test)** | Real Tug.app mounts gallery cards / transcript fixtures and exercises collapse/copy | variant + migration steps |
| **Golden / Contract** | Existing transcript snapshot fixtures render through the new base unchanged | after each migration |

#### What stays out of tests {#test-non-goals}

- No jsdom render-assertion tests or mock-store tests — banned house pattern; drive the real app via `just app-test` (per project guidance: real, not fake).
- No pixel-diff snapshotting of the `tool` variant — covered by eyeball + data-slot stability; pixel snapshots are brittle here.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Rename steps must keep `data-slot` strings stable.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Rename chrome + header + dirs + helper bits to `Block` | done | 526d03b9 |
| #step-2 | Fold `--tugx-toolblock-*` into `--tugx-block-*` | done | 46e25a0f |
| #step-3 | Add the `variant` axis (resolve [Q01]) | done | 2c1c08cd |
| #step-4 | Migrate Thinking → `note` variant (resolve [Q02]) | done | 0376aaae |
| #step-5 | Migrate commit receipt → `receipt` variant | done | 434056be |
| #step-6 | Unify markdown tables as the `data` variant | done | 88039784 |
| #step-7 | Integration checkpoint — borrowers coexist | done | N/A (verification) |
| #step-8 | Gallery clear & rebuild | done | badf9b45 |
| #step-9 | tuglaws / docs naming sweep | done | 38447790 |

#### Step 1: Rename chrome + header + dirs + helper bits to `Block` {#step-1}

**Commit:** `Rename ToolBlockChrome to BlockChrome and tool-blocks to blocks`

**References:** [P01] (#p01-block-is-base), [P06] (#p06-dispatch-types-stay), Spec S02, (#architecture-map, #symbol-inventory)

**Artifacts:**
- `cards/tool-blocks/` → `cards/blocks/`; `tool-block-chrome.{tsx,css}` → `block-chrome.{tsx,css}`; `tool-call-header.{tsx,css}` → `block-header.{tsx,css}`; `body-bits/` → `block-bits/` (and its `tool-block-{body,field-row,disclosure,pre}.{tsx,css}` → `block-{body,field-row,disclosure,pre}.{tsx,css}`).
- Symbol renames `ToolBlockChrome→BlockChrome`, `ToolCallHeader→BlockHeader`, `ToolBlock{Body,FieldRow,Disclosure,Pre}→Block*`, plus their `*Props`.
- **NOT renamed ([P06]):** the dispatch/types contract `ToolBlockProps`, `ToolBlockStatus`, `ToolBlockFactory`, `NullToolBlock`, `resolveToolBlock`, `TOOL_BLOCK_REGISTRY`, `BESPOKE_FACTORY_BY_NAME`, `registerToolBlock` — these move with `types.ts` into `cards/blocks/` but keep their names.
- All 20 wrapper imports + the dispatch imports updated; `data-slot` strings left unchanged.

**Tasks:**
- [ ] Move files (`git mv`) and update intra-module imports — including `types.ts` (path moves, names stay per [P06]).
- [ ] Rename the component symbols + prop interfaces; keep `toolName` prop name ([S02]).
- [ ] Update `dev-assistant-renderer-dispatch.ts` import paths; keep the `ToolBlock*` type names and the factory keys unchanged ([P06]).
- [ ] Leave `data-slot="tool-block-*"` and `data-slot="tool-call-header*"` strings as-is (contract stability) — note in a comment they are legacy-named slot contracts.

**Tests:**
- [ ] `bun run check` clean.
- [ ] `just app-test` passes (data-slots unchanged).

**Checkpoint:**
- [ ] `rg "ToolBlockChrome|ToolCallHeader" tugdeck/src` → no hits.
- [ ] `bun run check` exits 0.

---

#### Step 2: Fold `--tugx-toolblock-*` into `--tugx-block-*` {#step-2}

**Depends on:** #step-1

**Commit:** `Converge toolblock status tokens into the block family`

**References:** [P02] (#p02-token-convergence), [L17] one-hop token resolution, [L20] published-token exception, Spec S01, (#token-taxonomy)

**Artifacts:**
- The `--tugx-toolblock-*` **definitions** live in `block-chrome.css`'s `body{}` block (NOT the theme files — `brio.css`/`harmony.css`/`tug-active-theme.css` only carry pointer *comments* to them). Rename the defs there → `--tugx-block-*` status slots, and update those theme-file comments. Preserve the one-hop `--tugx-block-* → --tug*` resolution ([L17]).
- `--tugx-toolblock-header-height` → `--tugx-block-header-height`. This is a **published position-coordination token** ([L20] single-writer/many-readers exception). Writer: `block-chrome.tsx`'s `useLayoutEffect`/`ResizeObserver`. Readers to update in lockstep: `body-kinds/file-block.tsx`, `body-kinds/json-tree-block.tsx`, `body-kinds/diff-block.css`, `body-kinds/agent-transcript-block.css`.
- Other in-`src` consumers of `--tugx-toolblock-*` to rename: `tug-markdown-view.css`, plus every `tool-blocks/` (now `blocks/`) `.tsx`/`.css` that references the family (bash, web-fetch, web-search, task, ask-user-question, middle-ellipsis-path, the block-bits, and the chrome).

**Tasks:**
- [ ] Rename every `--tugx-toolblock-*` def (in `block-chrome.css` body) + every reference across `src` (use `rg` to enumerate; the body-kinds readers and `tug-markdown-view.css` are the cross-component ones).
- [ ] Verify no name collision with the existing shared `--tugx-block-*` surface slots (`-strip-*`, `-text-*`, `-code-font`) — the status slots are `-header-*`, `-args-*`, `-caution-*`, `-footer-*`, `-streaming-*`, `-actions-gap`, `-header-height`, none of which collide.

**Tests:**
- [ ] `bun run check` clean.
- [ ] Visual: gallery `tool` cards unchanged under HMR; **eyeball a diff hunk-header pin and a JSON-tree pin** — a stale `--tugx-toolblock-header-height` `var()` fails silently (`tsc` won't catch it).

**Checkpoint:**
- [ ] `rg "tugx-toolblock-" tugdeck/src tugdeck/styles` → no hits (comments included).
- [ ] A scrolled diff/file/json body still pins its inner header below the chrome header (no overlap).

---

#### Step 3: Add the `variant` axis {#step-3}

**Depends on:** #step-2

**Commit:** `Add variant axis to BlockChrome (tool default)`

**References:** [P03] (#p03-variant-via-attributes), [Q01] (#q01-variant-api-shape), Spec S02, (#state-zone-mapping)

**Artifacts:**
- `variant?: "tool" | "receipt" | "note" | "data"` on `BlockChromeProps`; `data-variant` on the root; `[data-variant]` CSS scaffolding (empty overrides for non-`tool` variants for now).
- A `[P##]` recording the [Q01] resolution.

**Tasks:**
- [ ] **Resolve [Q01]** — spike `note`/`data` headers against the single-component model; decide single-component vs thin-wrapper; record `[P##]`.
- [ ] Implement the chosen shape; default `"tool"` renders identically (no `data-variant` value-dependent rule yet).
- [ ] Add `[data-variant="receipt"|"note"|"data"]` CSS blocks (placeholders to be filled by Steps 4–6).

**Tests:**
- [ ] `bun run check` clean.
- [ ] `just app-test` passes; `tool` variant unchanged.

**Checkpoint:**
- [ ] A throwaway `variant="receipt"` render stamps `data-variant="receipt"` (DOM inspect) with no change to `tool`.

---

#### Step 4: Migrate Thinking → `note` variant {#step-4}

**Depends on:** #step-3

**Commit:** `Render the thinking block through the note block variant`

**References:** [P03] (#p03-variant-via-attributes), [Q02] (#q02-thinking-tokens), [D14], [L22], (#architecture-map)

**Artifacts:**
- `DevThinkingBlock` composes `BlockChrome variant="note"` (markdown body via `TugMarkdownBlock`), preserving streaming subscription and default-collapsed-on-complete.
- A `[P##]` recording the [Q02] resolution (retire vs keep `--tugx-thinking-*`).

**Tasks:**
- [ ] **Resolve [Q02]** at kickoff; record `[P##]`.
- [ ] Re-home Thinking onto `BlockChrome`; keep the `PropertyStore` path and imperative deltas verbatim ([L22]).
- [ ] Apply the [Q02] token decision (fold into `[data-variant="note"]` or keep sub-family).

**Tests:**
- [ ] `bun run check` clean.
- [ ] Gallery `note`/thinking card: streaming deltas render live; static mode default-collapsed.

**Checkpoint:**
- [ ] Streaming thinking shows live deltas; toggling collapses/expands via `data-collapsed`.

---

#### Step 5: Migrate commit receipt → `receipt` variant {#step-5}

**Depends on:** #step-3

**Commit:** `Render the commit receipt through the receipt block variant`

**References:** [P03] (#p03-variant-via-attributes), [D05], (#architecture-map)

**Artifacts:**
- `CommitBlock` rendered under `BlockChrome variant="receipt"`; the bespoke accent-rail/graph-node folded into the `[data-variant="receipt"]` scope.

**Tasks:**
- [ ] Move receipt-specific framing into the receipt variant scope; keep the per-file disclosures + stat badges.
- [ ] Verify the Bash→git-commit detection path still routes into the receipt variant.

**Tests:**
- [ ] `bun run check` clean.
- [ ] Gallery commit card renders rail + diffstat + file breakdown.

**Checkpoint:**
- [ ] A `git commit` bash fixture renders the receipt variant with no regression.

---

#### Step 6: Unify markdown tables as the `data` variant {#step-6}

**Depends on:** #step-2, #step-3

**Commit:** `Stamp markdown table chrome as the data block variant`

**References:** [P04] (#p04-two-substrates), Spec S01, (#react-dom-contract)

**Artifacts:**
- `enhance-block-chrome` stamps `data-variant="data"`; confirm it reads only `--tugx-block-*` (post-rename) + `--tug-button-xs-*`.
- A short contract note in the module docstring pointing at [#react-dom-contract].

**Tasks:**
- [ ] Add `data-variant="data"` to the built frame.
- [ ] Audit the table chrome CSS for any lingering `--tugx-toolblock-*` reference (should be none after Step 2).

**Tests:**
- [ ] `bun run check` clean.
- [ ] Markdown table fixture (1KB/50KB cards) sorts, copies, folds.

**Checkpoint:**
- [ ] A rendered markdown table carries `data-variant="data"` and matches the chrome look.

---

#### Step 7: Integration checkpoint — borrowers coexist {#step-7}

**Depends on:** #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** [P01], [P03], [P04], (#success-criteria)

**Tasks:**
- [ ] Verify Thinking (`note`), commit (`receipt`), tables (`data`), and tools (`tool`) render in one transcript via a real session/fixture.

**Tests:**
- [ ] `just app-test` full pass.

**Checkpoint:**
- [ ] A transcript containing all four variants mounts, collapses, and copies correctly.

---

#### Step 8: Gallery clear & rebuild {#step-8}

**Depends on:** #step-7

**Commit:** `Rebuild gallery block cards around the four variants`

**References:** [P05] (#p05-gallery-rebuild), (#architecture-map)

**Artifacts:**
- Delete the 31 `CATEGORIES.blockRenderers` cards except app-test-referenced fixtures; add `gallery-block-variants`, `gallery-block-states`, `gallery-block-body-kinds`.
- Update `gallery-registrations.tsx` imports + `registerCard` calls + `CATEGORIES`.

**Tasks:**
- [ ] Inventory which gallery cards app-tests mount (`gallery-bash-mount-in-saved-state`, markdown KB cards, transcript-copy/markdown); preserve those.
- [ ] Delete superseded cards + their `.css`; register the ~3 new cards.
- [ ] `log()`/note any retired card a test referenced (should be zero after the inventory).

**Tests:**
- [ ] `bun run check` clean.
- [ ] Gallery boots; `just app-test` mounts preserved fixtures.

**Checkpoint:**
- [ ] `blockRenderers` category shows the new card set; no dangling imports.

---

#### Step 9: tuglaws / docs naming sweep {#step-9}

**Depends on:** #step-8

**Commit:** `Update tuglaws references from tool block to block`

**References:** [P01], [P02], [P06], (#context, #token-taxonomy)

**Artifacts:**
- `tuglaws/component-authoring.md` carries **substantive** block-surface documentation that must track Steps 1–2, not just prose: the literal `.tool-block-chrome` / `.tool-block-chrome-header` CSS examples, the pin-stack formula using `--tugx-toolblock-header-height`, the actions-portal contract (`ToolBlockChrome` / `data-slot="tool-block-actions"` / `useChromeActionsTarget`), the `tugx-block.css` shared-surface pointer, and a stale `TideThinkingBlock` mention. Update all of these to the renamed symbols/tokens/paths.
- `tuglaws/design-decisions.md` and other tuglaws prose that names "tool block" as the *base* updated to the block/variant vocabulary; cross-links fixed. (Per-tool "tool block" wording stays where it means the `tool` variant; the `ToolBlock*` dispatch names stay per [P06].)

**Tasks:**
- [ ] Update the `component-authoring.md` code examples + pin-stack formula to `block-chrome` / `--tugx-block-header-height` / `BlockChrome`; fix the `tugx-block.css` reference and the `TideThinkingBlock` → `note`-variant mention.
- [ ] Grep tuglaws for base-level "tool block" / `ToolBlockChrome` naming; update to `BlockChrome`/variant terms; leave `ToolBlock*` dispatch-type names intact ([P06]).

**Tests:**
- [ ] Docs-only; no code gate. `bun run check` still clean (unchanged).

**Checkpoint:**
- [ ] `rg -i "toolblockchrome|tool-block-chrome|tugx-toolblock" tuglaws` → no stale base references.
- [ ] The `component-authoring.md` pin-stack example compiles mentally against the renamed token (`--tugx-block-header-height`).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A `BlockChrome` renderer with a `tool`/`receipt`/`note`/`data` variant axis, with the commit receipt, markdown tables, and Thinking block all rendered through the shared block contract, a converged `--tugx-block-*` token vocabulary, and a rebuilt per-variant gallery.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `rg "ToolBlockChrome|ToolCallHeader|tugx-toolblock-" tugdeck/src tugdeck/styles` → no hits. (grep)
- [ ] Thinking, commit, and table chromes all route through the block contract; [Q02] resolved (retired or sub-family). (code review)
- [ ] `bun run check` clean and `just app-test` green. (commands)
- [ ] Gallery shows ~6 block cards (4 variants + states + body-kinds); preserved fixtures still mount. (gallery boot, app-test)
- [ ] [Q01] and [Q02] each recorded as a `[P##]` decision. (plan review)

**Acceptance tests:**
- [ ] `just app-test` full pass with a transcript exercising all four variants.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Consider renaming the `toolName` prop to a content-neutral `title` once wrappers are revisited.
- [ ] Consider renaming the legacy `data-slot="tool-block-*"` contracts (coordinated with app-tests).
- [ ] Evaluate a fifth variant for future block kinds (e.g. attachment previews).

| Checkpoint | Verification |
|------------|--------------|
| Rename complete | `rg "ToolBlockChrome\|tugx-toolblock-"` → empty |
| Variants live | gallery `gallery-block-variants` renders four looks |
| Borrowers migrated | one transcript renders tool + receipt + note + data |
| Gallery rebuilt | `blockRenderers` category = new card set |
