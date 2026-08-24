<!-- devise-skeleton v4 -->

## Clickable Slash Commands in the Transcript {#clickable-slash-commands}

**Purpose:** Make a backticked slash command that appears in assistant/tool prose in the Dev card transcript (e.g. `` `/tugplug:implement dash/find-route.md` ``) hover-underline and be **clickable** — one click activates the card, switches to the Code route, drops an atomized, ready-to-run command into the prompt-entry editor, and focuses it, so the user can execute with a single keystroke.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-12 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Dev card transcript renders assistant and tool prose through a WASM markdown pipeline. Slash commands like `/tugplug:implement dash/find-route.md` frequently appear in that prose as inline `` `code` `` spans — a hint to the user of the exact command to run next. Today that text is inert: the user must retype or hand-copy the command into the composer. The composer already has first-class slash-command **atoms** (chips) and a completion pipeline that turns a typed `/name` into a command atom; we want a click in the transcript to produce the same atomized, execute-ready draft without any typing.

The user's explicit guidance: **validate clickability against the known command list, strictly** — not a loose regex. We know the registered command set at runtime (claude's catalog plus the dev card's local commands), so only spans whose command name is actually in that set become clickable.

#### Strategy {#strategy}

- Add a new markdown **enhancer** (`enhanceSlashCommands`) beside the existing `enhance-*` passes. It walks rendered inline `<code>` spans, parses each against a strict command-line grammar, and — for spans whose command name passes a caller-supplied **known-command predicate** — tags the `<code>` with a class and `data-*` attributes. This is pure DOM ([L06]); no store dependency inside the pipeline.
- Thread an optional `isKnownSlashCommand` predicate from the transcript (which owns the live catalog) down through `TugMarkdownBlock` → `renderIncremental` → the enhancer. When the predicate is absent (every other markdown consumer), the enhancer is a no-op, so nothing else in the app changes. **The block reads the predicate from a ref inside its `reconcile` closure, not from a captured prop** — the streaming render effect's deps are `[streamingStore, streamingPath]`, so a closed-over prop would be stale ([P02], [R02]).
- Style the tagged span with hover underline + pointer cursor via CSS ([L06]).
- Handle the click with **one delegated listener** on the `.dev-card-transcript` root (which has `cardId`, `useDeckManager()`, and `codeSessionStore`). On a click it activates the card and sets a new store slot, `pendingCommandInsert`, on `codeSessionStore`.
- The prompt entry **consumes** that slot in a `useLayoutEffect` — mirroring the existing `pendingShare` / `pendingDraftRestore` effects — by flipping the route to Code (`❯`), seeding the editor with a command atom (+ trailing arg text), and focusing. Decoupling transcript from composer via a store slot, not a direct delegate reach, follows the established pattern.

#### Success Criteria (Measurable) {#success-criteria}

> Make these falsifiable. Avoid "works well".

- In a live Dev card session, an assistant message containing `` `/tugplug:implement dash/find-route.md` `` renders that span with a hover underline and `cursor: pointer`, verified in the running app. (#success-criteria)
- A backticked non-command (e.g. `` `/Users/kocienda/x` `` or `` `/notacommand` ``) shows **no** hover affordance and is **not** clickable — proving the strict known-list gate. ([P01])
- Clicking the command span: (a) brings the card forward / makes it active, (b) the route indicator reads Code (`❯`), (c) the composer holds a `/tugplug:implement` command **chip** followed by the literal text `dash/find-route.md`, (d) the composer is focused with the caret at end, and (e) pressing Return submits and claude expands it as a user invocation. Verified end-to-end in the running app.
- `bunx vite build` succeeds and `cargo nextest run` (if any Rust touched — none expected) plus the tugdeck unit tests pass. ([#step-1], [#step-3])

#### Scope {#scope}

1. A new `enhanceSlashCommands` markdown enhancer + a pure `parseSlashCommandLine` grammar helper, wired (optionally) into `render-incremental.ts`.
2. An optional `isKnownSlashCommand` prop on `TugMarkdownBlock` threaded to the enhancer; the transcript supplies it from the live catalog.
3. CSS hover/pointer styling for the tagged span.
4. A `pendingCommandInsert` slot on `CodeSessionStore` + `insertCommandDraft` / `consumePendingCommandInsert` actions.
5. A prompt-entry `useLayoutEffect` that consumes the slot (route flip + atomized seed + focus).
6. A delegated click listener on the transcript root that activates the card and sets the slot.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Making the **argument** (e.g. `dash/find-route.md`) its own file **atom**. The command becomes an atom; the argument stays plain trailing text, which is fully executable (`/name args` expands). File-atomizing the argument is a follow-on ([Q03]).
- Keyboard activation / tab-focus of the code span (mouse-first). Deferred ([Q02]).
- Making slash commands in **un-backticked** prose clickable. Only inline `<code>` spans are targeted (bounded, deliberate, no false positives in flowing prose). ([P01])
- Any change to how commands are typed, completed, or submitted from the composer — this feature only *produces* a draft the existing submit path already handles.
- **Tool-result prose.** Only the `assistant_text` message is wired in this phase. Tool results can also contain backticked commands, but they mount through a different renderer path; extending the same enhancer to them is a follow-on (#roadmap). The motivating case (the devise/implement hint in assistant prose) is `assistant_text`.

#### Dependencies / Prerequisites {#dependencies}

- Existing atom + command infrastructure: `AtomSegment` (`src/lib/tug-atom-img.ts`), command-atom helpers (`src/lib/command-atom.ts`), `buildEditingStateFromDraftRestore` (`src/components/tugways/tug-prompt-entry.tsx`).
- The live command catalog: `SessionMetadataStore.slashCommands` (`src/lib/session-metadata-store.ts`) and `LOCAL_SLASH_COMMANDS` (`src/lib/slash-commands.ts`).
- The markdown enhancer pipeline: `render-incremental.ts` and the `enhance-*.ts` siblings under `src/lib/markdown/`.

#### Constraints {#constraints}

- Tugdeck laws: [L02] external state through `useSyncExternalStore`, [L03] `useLayoutEffect` for registrations events depend on, [L06] appearance via CSS/DOM not React state. See [`tuglaws/tuglaws.md`](../tuglaws/tuglaws.md).
- WARNINGS ARE ERRORS in the Rust workspace; not expected to be touched, but no warnings anywhere.
- Verify with `bunx vite build` (the debug app loads the production rollup bundle — an import that only works under dev esbuild can hang the app at the splash screen).
- Use existing Tug components/helpers; do not hand-roll atom construction — reuse `AtomSegment` shape and `buildEditingStateFromDraftRestore`.

#### Assumptions {#assumptions}

- `SlashCommandInfo.name` in the catalog is the **full** command token as typed — the `plugin:command` form for plugin commands (`tugplug:implement`) and bare `command` for others — matching what the chip displays and what the completion provider keys off (`getCommandCompletionProvider` builds items with `value: cmd.name`). Verify against a live catalog snapshot during [#step-2].
- The catalog is populated **from the drop** (the `initialize` handshake `session_capabilities`), so by the time any assistant message renders, `slashCommands` is non-empty in the normal case. Enhancement happens once at block build/update time and finalized blocks are not re-enhanced on a later catalog change — but for `assistant_text` that change effectively cannot happen after the drop, so the tag is correct at mount ([R02]).
- The transcript's `assistant_text` `TugMarkdownBlock` mount site can receive a predicate argument from the host render (the host reads the catalog via `useSyncExternalStore`).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit `{#kebab-case}`; plan-local decisions are `[P01]` (never `[D01]`); steps cite artifacts, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Composer non-empty on click (OPEN→DECIDED) {#q01-composer-non-empty}

**Question:** What happens when the user clicks a transcript command while the composer already holds a draft?

**Why it matters:** A slash command claude expands as a user invocation must be the **leading** atom at document position 0 (see `command-atom.ts` `hasLeadingCommandAtom` and the wire-expansion note). You cannot splice a leading command into the middle of an existing draft and keep it executable, so "insert without disturbing the draft" is not a coherent option.

**Options (if known):**
- Replace the composer content with the atomized command (execute-ready).
- Refuse / no-op when non-empty (fails "ready to execute with one stroke").
- Append the command as trailing plain text (not a leading atom → not expanded → wrong).

**Plan to resolve:** Decided in-plan.

**Resolution:** DECIDED (see [P04]) — replace, because a click is an explicit intent to run *this* command and the leading-position requirement rules out the alternatives. Draft-clobber tracked as [R01].

#### [Q02] Keyboard activation of the span (OPEN→DEFERRED) {#q02-keyboard-activation}

**Question:** Should the clickable command span be tab-focusable and Enter/Space-activatable?

**Why it matters:** Accessibility. But the transcript is a read-only surface and adding tabindex to inline spans interacts with the [reference] mousedown-focus and read-only-list-renders-no-tabindex conventions.

**Resolution:** DEFERRED — mouse-first for this phase; a keyboard affordance is a follow-on (#roadmap).

#### [Q03] File-atomizing the argument (OPEN→DEFERRED) {#q03-file-atom-arg}

**Question:** Should an argument that is a file path (`dash/find-route.md`) be seeded as a **file** atom rather than plain text?

**Why it matters:** Nicer chip rendering + path resolution, but requires resolving the arg against the file tree and disambiguating non-path args.

**Resolution:** DEFERRED — plain trailing text is fully executable (`/name args` expands). File-atomization is a follow-on (#roadmap).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Draft clobber on click when composer non-empty | med | low | Explicit user gesture; documented; follow-on could confirm/stash | user reports lost drafts |
| Catalog late-arrival → span not yet clickable | low | very low | Catalog is from-the-drop; enhancement is correct at block mount; finalized blocks not re-enhanced but assistant_text never renders pre-catalog | catalog observed empty at an assistant render |
| Shared markdown renderer signature change ripples to all consumers | med | low | New param is **optional**; enhancer no-ops when absent | build/type breakage in other consumers |
| Grammar false-positive makes a non-command clickable | med | low | Strict grammar **and** known-list predicate must both pass | any unknown span shows affordance |

**Risk R01: Draft clobber** {#r01-draft-clobber}

- **Risk:** Clicking a command replaces an in-progress composer draft.
- **Mitigation:** The seed is an explicit user gesture on a specific command; the common case is an empty composer; behavior is documented.
- **Residual risk:** A user mid-compose who clicks loses that text. Acceptable for this phase; a confirm/stash guard is a possible follow-on.

**Risk R02: Catalog late-arrival** {#r02-catalog-late}

- **Risk:** An assistant message renders before the command catalog lands, so its command spans aren't tagged.
- **Reality of the mechanism:** Enhancement is a **build/update-time** act — it runs only inside `buildBlockElement` / `updateBlockElement` (`render-incremental.ts`). The reconciler **skips hash-stable blocks**, so re-invoking `renderIncremental` with unchanged text does **not** re-enhance an already-built (finalized) block. There is therefore **no** "re-render → re-enhance" mitigation; a finalized block keeps whatever tags it got at build time.
- **Mitigation:** The predicate is read from a **ref** inside the block's `reconcile` closure (updated on each render), so it is current at the first (mount) build — which is what tags a finalized `assistant_text` block — and also current for any *streaming* delta that builds/updates a block mid-turn. Because the catalog is populated from-the-drop, an `assistant_text` block never builds before the catalog exists, so the mount-time tag is correct.
- **Residual risk:** If the catalog somehow changed *after* a finalized block was built (not observed for assistant text), that block's already-rendered commands would not re-tag until its text changes (which finalized text never does). Accepted as effectively unreachable.

**Risk R03: Shared-renderer ripple** {#r03-shared-renderer}

- **Risk:** Threading a param through `renderIncremental` / `buildBlockElement` touches a hot, shared path used by every markdown surface.
- **Mitigation:** The param is optional; when omitted the enhancer is skipped and behavior is byte-identical to today. Covered by `bunx vite build` + existing markdown tests.
- **Residual risk:** None expected.

---

### Design Decisions {#design-decisions}

#### [P01] Backtick-only + strict known-list gate (DECIDED) {#p01-strict-gate}

**Decision:** A transcript slash command is clickable **iff** (a) it is an inline `<code>` span, (b) its text matches the strict command-line grammar, **and** (c) its command name is present in the live known set — `SessionMetadataStore.slashCommands` ∪ `LOCAL_SLASH_COMMANDS`. All three must hold.

**Rationale:**
- The user's explicit guidance: match against the known list strictly, not a loose regex.
- Backticked-only bounds the target and avoids false positives in flowing prose; the existing `enhanceLinks` already ignores `CODE`/`PRE`, so there is no conflict with URL autolinking.
- The grammar alone already excludes file paths (a path has interior `/`); the known-list check is the strict backstop.

**Implications:**
- The enhancer needs a caller-supplied predicate (the pipeline stays store-free).
- Unknown commands render as ordinary inline code — no affordance, no listener target.

#### [P02] Enhancer tags DOM; known-check via injected predicate (DECIDED) {#p02-enhancer-predicate}

**Decision:** `enhanceSlashCommands(container, isKnown)` parses each inline `<code>`, and when the grammar matches **and** `isKnown(name)` returns true, sets on that `<code>`: class `tugx-md-slashcmd`, `data-slash-command="<name>"`, `data-slash-args="<args>"` (empty string when none). No wrapping element is introduced — the existing `<code>` is annotated in place.

**Rationale:**
- Keeps the WASM/markdown pipeline pure and store-free ([L06]); the predicate carries the only live dependency.
- Applying the known-check **during** enhancement (not in a later effect) means streaming DOM rebuilds re-tag atomically — a later transcript effect would be wiped by the next delta's `innerHTML` rewrite.

**Implications:**
- `renderIncremental` / `renderIncrementalFromBlocks` / `buildBlockElement` / `updateBlockElement` gain an optional options carrier (e.g. `{ isKnownSlashCommand?: (name: string) => boolean }`); when absent, `enhanceSlashCommands` is skipped.
- `TugMarkdownBlock` gains an optional `isKnownSlashCommand` prop. It must **not** be closed over directly in the streaming render effect — that effect's deps are `[streamingStore, streamingPath]` (it does not re-run on a prop change), so a captured prop would be stale. Instead the block stores the latest predicate in a `useRef` assigned on every render and the `reconcile` closure reads `predicateRef.current`, passing it into `renderIncremental` / `renderIncrementalFromBlocks`. This makes the predicate current at the mount build (which tags finalized blocks) and at every streaming delta, without adding it to the effect deps.

#### [P03] Interaction via a `pendingCommandInsert` store slot (DECIDED) {#p03-store-slot}

**Decision:** The transcript click sets `codeSessionStore.insertCommandDraft(name, args)`, which parks `{ name, args }` on a new `pendingCommandInsert` snapshot slot. The prompt entry consumes it in a `useLayoutEffect`, mirroring the existing `pendingShare` and `pendingDraftRestore` effects, then calls `consumePendingCommandInsert()`.

**Rationale:**
- The composer's route (`RouteLifecycle`) and atom insertion are internal to `TugPromptEntry`; the `entryDelegateRef` deliberately does **not** re-expose `insertAtom`. A store slot the entry already observes is the established, decoupled channel (`applyShellShare` is the direct precedent).
- Keeps [L02] clean: the slot enters the entry via `useSyncExternalStore`; the effect is `useLayoutEffect` ([L03]) so the doc change + route flip land in one paint.

**Implications:**
- New snapshot field + two actions on `CodeSessionStore`; the transcript needs no reference to the composer.

#### [P04] Seed replaces composer with the leading command atom + trailing text (DECIDED) {#p04-seed-replace}

**Decision:** Consuming the slot builds a fresh editing state via `buildEditingStateFromDraftRestore(text, atoms)` with `text = TUG_ATOM_CHAR + (args ? " " + args : "")` and `atoms = [{ kind: "atom", type: "command", label: name, value: name }]`, then `editor.restoreState(...)` (which **replaces** content), sets the route to `❯` (`DEFAULT_ROUTE`), and focuses. Caret lands at end-of-doc (restore selection is `null`).

**Rationale:**
- A command claude expands as a user invocation must be the leading atom at position 0 (`command-atom.ts`); this guarantees it.
- `restoreState` is the same mechanism `pendingDraftRestore` uses to inject full text+atoms; reusing it means the command chip renders identically to a typed one.
- Replace (not the draft-restore empty-guard) delivers "ready to execute with one stroke." ([Q01], [R01])

**Implications:**
- Unlike the `pendingDraftRestore` effect, this seed is **unconditional** (no empty-guard) — a distinct slot is required so the two behaviors don't collide.

#### [P05] Command value is the bare name; slash only at the wire (DECIDED) {#p05-bare-name}

**Decision:** The command atom stores the **bare** name (`tugplug:implement`, no leading slash) in both `label` and `value`, exactly as the completion providers do. The leading `/` is added only at the wire boundary by the existing `commandWireText`; the chip shows the slash via `chipDisplayLabel`.

**Rationale:** This is the single-source-of-truth convention documented in `command-atom.ts`; deviating would break chip rendering and claude's expansion.

**Implications:**
- The enhancer's parsed `name` (from the `<code>` text) already excludes the leading `/`; store it verbatim.
- The known set spans **both** claude commands and the dev card's **local** commands (`LOCAL_SLASH_COMMANDS`). Seeding a *local* command (`/diff`, `/model`, `/permissions`) produces a local command atom that the existing submit path intercepts and opens as a graphical surface rather than sending to claude — this is correct and desirable (clicking `` `/diff` `` opens the diff surface), not a special case to handle.

#### [P06] Card activation from the transcript via DeckManager (DECIDED) {#p06-activate}

**Decision:** The delegated click handler calls `deck.activateCard(cardId)` (via `useDeckManager()`, already used in the host) before setting the slot; the composer focus is then applied by the entry's slot-consuming effect (`editor.focus()`, which promotes the responder chain).

**Rationale:** `activateCard` runs the full first-responder lifecycle; the subsequent `editor.focus()` lands first responder on the composer. Splitting activation (transcript) from focus (entry) matches the existing `pendingShare` flow, where the entry's effect owns the focus call.

**Implications:** No `transferFocusForActivation` wrapper is needed because the entry explicitly focuses the composer after; if a focus-save regression appears, escalate to that wrapper (#roadmap).

---

### Deep Dives (Optional) {#deep-dives}

#### Command-line grammar {#command-grammar}

**Spec S01: `parseSlashCommandLine`** {#s01-grammar}

Input: the `textContent` of an inline `<code>` span, already trimmed. Output: `{ name: string; args: string } | null`.

- Must start with a single `/`.
- `name` grammar: `plugin:command` or bare `command`, where each segment is `[a-z0-9]` optionally followed by `[a-z0-9_-]*[a-z0-9]` (lowercase, digits, `_`, `-`; no leading/trailing separators; at most one `:` splitting plugin from command). **No interior `/`.**
- Optional args: after the name, one-or-more whitespace then the remainder (any characters), captured trimmed as `args`. No args ⇒ `args: ""`.
- Rejections (return `null`): empty/whitespace, no leading `/`, uppercase-led or path-shaped tokens with interior `/` (`/Users/kocienda/x`), a bare `/`, or anything with a scheme (`https://…`).

Regex sketch (finalize + unit-test in [#step-1]):
```
^\/([a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?::[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)?)(?:\s+([\s\S]+))?$
```

Note: the grammar is necessary but **not sufficient** — the known-list predicate ([P01]) is the authoritative gate. The grammar exists so `enhanceSlashCommands` can cheaply reject the overwhelming majority of code spans before consulting the predicate, and so it can split `name` from `args`.

#### Known-set predicate source {#known-set}

**List L01: The known command set** {#l01-known-set}

The predicate returns true iff the parsed `name` is in the union of:
- `sessionMetadataStore.getSnapshot().slashCommands.map((c) => c.name)` — claude's catalog (skills, agents, plugin commands, claude's own), read live.
- `LOCAL_SLASH_COMMANDS.map((c) => c.name)` — the dev card's locally-handled commands (`src/lib/slash-commands.ts`).

Built once per render in the host with `useMemo` over the catalog snapshot (a `Set<string>` for O(1) lookup) and passed down to the `assistant_text` `TugMarkdownBlock` mount. Identity changes when the catalog changes ([R02]).

#### End-to-end click flow {#click-flow}

1. User clicks inside a `<code class="tugx-md-slashcmd" data-slash-command data-slash-args>` in the transcript.
2. The delegated listener on `.dev-card-transcript` matches `event.target.closest(".tugx-md-slashcmd")`, reads `data-slash-command` / `data-slash-args`.
3. `deck.activateCard(cardId)` ([P06]).
4. `codeSessionStore.insertCommandDraft(name, args)` parks the slot ([P03]).
5. The entry's `useLayoutEffect` sees `snap.pendingCommandInsert`, builds the editing state ([P04]/[P05]), `restoreState`, `setRoute("❯")`, `focus()`, `consumePendingCommandInsert()`.
6. Composer now shows the `/tugplug:implement` chip + `dash/find-route.md` text, focused, caret at end. Return submits; the existing submit path expands it.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `.tugx-md-slashcmd` class + `data-slash-*` attrs on `<code>` | structure/appearance | DOM written by `enhanceSlashCommands` (imperative, in the render pipeline) | [L06] |
| Hover underline + `cursor: pointer` | appearance | CSS on `.tugx-md-block code.tugx-md-slashcmd` | [L06] |
| `isKnownSlashCommand` predicate | derived/local-data | `useMemo` over `SessionMetadataStore` snapshot read via `useSyncExternalStore` in the host; delivered to the block via a per-render `predicateRef` read in `reconcile` (not an effect dep) | [L02] |
| `pendingCommandInsert` slot | local-data | `CodeSessionStore` snapshot field + actions; entry reads via `useSyncExternalStore` | [L02] |
| Slot consumption (route flip + seed + focus) | — | `useLayoutEffect` in the entry (same-paint doc change) | [L03] |
| Delegated click listener registration | — | `useLayoutEffect` on the transcript root | [L03] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/markdown/enhance-slash-commands.ts` | `enhanceSlashCommands(container, isKnown)` + pure `parseSlashCommandLine(text)` |
| `tugdeck/src/lib/markdown/__tests__/enhance-slash-commands.test.ts` | grammar unit tests ([L19] file pair) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `parseSlashCommandLine` | fn | `lib/markdown/enhance-slash-commands.ts` | pure; Spec S01 |
| `enhanceSlashCommands` | fn | `lib/markdown/enhance-slash-commands.ts` | tags `<code>`; skips when no match/unknown |
| `renderIncremental` / `renderIncrementalFromBlocks` | fn (modify) | `lib/markdown/render-incremental.ts` | accept optional `{ isKnownSlashCommand? }` |
| `buildBlockElement` / `updateBlockElement` | fn (modify) | `lib/markdown/render-incremental.ts` | call `enhanceSlashCommands` when predicate present |
| `isKnownSlashCommand` | prop (add) | `TugMarkdownBlock` (`tug-markdown-block.tsx`) | optional; stored in a per-render `predicateRef` and read inside `reconcile` (NOT closed over / NOT an effect dep — [P02]) |
| `.tugx-md-block code.tugx-md-slashcmd` | CSS rule | `tug-markdown-view.css` | hover underline + pointer |
| `pendingCommandInsert` | snapshot field | `CodeSessionStore` (`src/lib/code-session-store/`) | `{ name, args } \| null` |
| `insertCommandDraft` / `consumePendingCommandInsert` | actions | `CodeSessionStore` | set / clear the slot |
| slot-consuming `useLayoutEffect` | effect | `tug-prompt-entry.tsx` | route→`❯`, seed, focus, consume |
| delegated click listener | effect | `dev-card-transcript.tsx` (`DevTranscriptHost`) | `closest(".tugx-md-slashcmd")` → activate + set slot |
| host `isKnownSlashCommand` memo | derived | `dev-card-transcript.tsx` | List L01 union → passed to `assistant_text` mount |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | `parseSlashCommandLine` grammar: valid/plugin/args/rejections | [#step-1] |
| **Unit** | `CodeSessionStore` slot set/consume + snapshot stability | [#step-3] |
| **Real-app verification** | Drive the running Tug.app: render, hover, click, submit | [#step-2], [#step-4], [#step-5] |

#### What stays out of tests {#test-non-goals}

- No jsdom/fake-DOM render tests of the enhancer — banned pattern; the enhancer is verified in the real app (`/verify` / `just app-test`), and the *pure* grammar is unit-tested. (Per project "real, not fake" policy.)
- No mock-store assertion tests — the store slot is exercised through its real action API and, end-to-end, in the app.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. References cite artifacts, never line numbers.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Grammar helper + enhancer + pipeline wiring | done | 6071a572e |
| #step-2 | Transcript predicate + block prop + hover CSS | done | b57a82baa |
| #step-3 | `pendingCommandInsert` slot + entry consumption | done | 4aa1dda44 |
| #step-4 | Delegated click → activate + set slot | done | 6dc4f46c6 |
| #step-5 | Integration checkpoint | done | N/A (verification only) |

#### Step 1: Grammar helper + enhancer + pipeline wiring {#step-1}

**Commit:** `tugdeck(clickable-slash): parse + enhance slash-command code spans`

**References:** [P01] strict gate, [P02] enhancer + predicate, Spec S01 (#command-grammar), (#strategy), [R03] shared-renderer ripple

**Artifacts:**
- New `lib/markdown/enhance-slash-commands.ts` (`parseSlashCommandLine`, `enhanceSlashCommands`).
- New test file `lib/markdown/__tests__/enhance-slash-commands.test.ts`.
- Modified `lib/markdown/render-incremental.ts` (optional predicate carrier → enhancer call).

**Tasks:**
- [ ] Implement `parseSlashCommandLine(text)` per Spec S01; return `{ name, args } | null`.
- [ ] Implement `enhanceSlashCommands(container, isKnown)`: query inline `<code>` (exclude `pre code`), parse, and when `isKnown(name)` is true set class `tugx-md-slashcmd` + `data-slash-command` + `data-slash-args`. No-op on non-match/unknown.
- [ ] Add an optional options carrier `{ isKnownSlashCommand?: (name: string) => boolean }` to `renderIncremental` and `renderIncrementalFromBlocks`; thread to `buildBlockElement` / `updateBlockElement`; call `enhanceSlashCommands` only when the predicate is present (byte-identical output when absent — [R03]).

**Tests:**
- [ ] Unit: valid bare command, valid `plugin:command`, command + args (args trimmed), no-args ⇒ `args: ""`.
- [ ] Unit: rejects `` `/Users/kocienda/x` `` (interior `/`), bare `/`, empty, `https://…`, uppercase-led.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/markdown/__tests__/enhance-slash-commands.test.ts` passes.
- [ ] `cd tugdeck && bunx vite build` succeeds (shared renderer still compiles; other consumers unaffected).

---

#### Step 2: Transcript predicate + block prop + hover CSS {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(clickable-slash): tag + style known command spans in transcript`

**References:** [P01] strict gate, [P02] enhancer + predicate, List L01 (#known-set), [R02] catalog late-arrival, (#success-criteria)

**Artifacts:**
- Modified `TugMarkdownBlock` (optional `isKnownSlashCommand` prop → `renderIncremental`).
- Modified `dev-card-transcript.tsx`: host builds the List L01 predicate (`useMemo` over the catalog) and passes it to the `assistant_text` `TugMarkdownBlock` mount.
- Modified `tug-markdown-view.css`: hover underline + `cursor: pointer` for `.tugx-md-block code.tugx-md-slashcmd`.

**Tasks:**
- [ ] Add `isKnownSlashCommand?: (name: string) => boolean` to `TugMarkdownBlockProps`. Store it in a `predicateRef` (`useRef`) assigned on **every** render; have the `reconcile` closure read `predicateRef.current` and pass it into both `renderIncremental` and `renderIncrementalFromBlocks`. Do **not** add the prop to the streaming effect's dep array (`[streamingStore, streamingPath]`) and do **not** close over it directly — see [P02] / [R02]. Also pass it in the static `initialText` mode's `renderIncremental` call for completeness (unused by the transcript, which is streaming-mode).
- [ ] In the host, memoize a `Set` from `sessionMetadataStore` catalog (read via the existing `useSyncExternalStore`) ∪ `LOCAL_SLASH_COMMANDS`; wrap as a `(name) => set.has(name)` predicate; thread it to the `assistant_text` mount site.
- [ ] Confirm the assumption that catalog `name` is the full `plugin:command` token by logging one live snapshot (`tugDevLogStore.debug`) or reading it in the app; adjust the predicate if names are namespaced differently.
- [ ] Add the CSS rule (hover underline + pointer). Keep the resting appearance identical to today's inline code so only hover reveals interactivity.

**Tests:**
- [ ] Real-app: in a live session, an assistant message with `` `/tugplug:implement dash/find-route.md` `` shows hover underline + pointer; `` `/notacommand` `` and `` `/Users/kocienda/x` `` do not.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` succeeds.
- [ ] Run the app (`/run` or the app-test harness); visually confirm the affordance appears only on known commands.

---

#### Step 3: `pendingCommandInsert` slot + entry consumption {#step-3}

**Commit:** `tugdeck(clickable-slash): command-insert store slot + composer seed`

**References:** [P03] store slot, [P04] seed replaces, [P05] bare name, (#click-flow), [R01] draft clobber

**Artifacts:**
- Modified `CodeSessionStore`: `pendingCommandInsert` snapshot field + `insertCommandDraft(name, args)` + `consumePendingCommandInsert()`.
- Modified `tug-prompt-entry.tsx`: a `useLayoutEffect` consuming the slot.

**Tasks:**
- [ ] Add `pendingCommandInsert: { name: string; args: string } | null` to the `CodeSessionStore` snapshot (default `null`); add `insertCommandDraft` (set + recompute) and `consumePendingCommandInsert` (clear + recompute) preserving snapshot-reference stability when unchanged.
- [ ] In `TugPromptEntry`, add a `useLayoutEffect` (mirroring the `pendingShare` effect) that, on a non-null slot: builds `buildEditingStateFromDraftRestore(TUG_ATOM_CHAR + " " + (args ? args : ""), [{ kind: "atom", type: "command", label: name, value: name }])`, calls `editor.restoreState(...)`, `routeLifecycle.setRoute(DEFAULT_ROUTE)`, `editor.focus()`, then `codeSessionStore.consumePendingCommandInsert()`. Unconditional seed (no empty-guard — [P04]).
- [ ] **Seed-shape parity:** insert `TUG_ATOM_CHAR + " "` (atom + trailing space) even for a no-arg command, matching what completion acceptance inserts for a typed command (`acceptCompletionAt` in `completion-extension.ts`), so a clicked command is byte-identical to a typed one and the caret sits after a space ready to keep typing.
- [ ] **Confirm `restoreState` fully replaces** prior content *and atoms* (not a merge). This is the queued-send-cancel path, which already carries command atoms, so it is proven — verify the resulting doc holds exactly the one command chip + arg text with no residue from a prior draft.
- [ ] Guard for a missing editor view (survive a late mount; leave the slot until an editor exists, like `pendingShare`).

**Tests:**
- [ ] Unit: `insertCommandDraft` sets the slot; `consumePendingCommandInsert` clears it; a no-op consume keeps snapshot identity stable.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` (store tests) passes.
- [ ] `cd tugdeck && bunx vite build` succeeds.

---

#### Step 4: Delegated click → activate + set slot {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck(clickable-slash): transcript click activates card + seeds command`

**References:** [P03] store slot, [P06] activation, (#click-flow), (#success-criteria)

**Artifacts:**
- Modified `dev-card-transcript.tsx` (`DevTranscriptHost`): a delegated `click` listener on the `.dev-card-transcript` root.

**Tasks:**
- [ ] In the host, add a `useLayoutEffect` ([L03]) that registers a delegated `click` listener on the transcript root element (`rootRef.current`, the same `.dev-card-transcript` element the host already binds `responseStore` CSS props to). On a click whose `event.target.closest(".tugx-md-slashcmd")` is non-null: read `data-slash-command` / `data-slash-args`, call `deck.activateCard(cardId)` then `codeSessionStore.insertCommandDraft(name, args ?? "")`. Clean up the listener on unmount.
- [ ] **Selection-drag guard:** ignore a click that is the tail of a text drag-selection over the span — bail when `window.getSelection()` is non-collapsed (or gate on `event.detail === 1`) so selecting text that overlaps a command doesn't fire the seed.

**Tests:**
- [ ] Real-app end-to-end (below).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` succeeds.

---

#### Step 5: Integration Checkpoint {#step-5}

**Depends on:** #step-2, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** [P01]–[P06], (#success-criteria), (#click-flow)

**Tasks:**
- [ ] Verify the whole flow in the running Tug.app on a real session that contains a backticked known command in assistant prose.

**Tests:**
- [ ] Click `` `/tugplug:implement dash/find-route.md` ``: card activates, route reads Code (`❯`), composer shows the `/tugplug:implement` chip + `dash/find-route.md` text, and **the composer is the first responder** (focused — assert focus explicitly, not just that the doc is populated; a non-tabindex `<code>` click plus programmatic focus must actually land first responder, per the `mousedown` default-focus behavior in `reference_mousedown_focus_default`). Caret at end; pressing Return submits and claude expands it.
- [ ] A backticked unknown command / path is not clickable (no affordance, click is inert).
- [ ] Clicking a backticked **local** command (e.g. `` `/diff` ``) seeds it and opens its local surface on submit (sanity that the local/claude split from [P05] holds through the click path).

**Checkpoint:**
- [ ] `/verify` (or `just app-test`) drives the flow end-to-end and observes the composer state, **first-responder focus**, and submission.
- [ ] `cd tugdeck && bunx vite build` and `cd tugrust && cargo nextest run` (if any Rust touched) are green.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Backticked, catalog-known slash commands in the Dev card transcript are hover-underlined and clickable; one click activates the card, switches to the Code route, seeds an atomized execute-ready command in the focused composer.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Known command spans show the hover affordance; unknown/path spans do not. ([P01])
- [ ] Click produces the correct chip + arg text, on the Code route, focused, in the active card. (#click-flow)
- [ ] Pressing Return submits and claude expands the command as a user invocation. ([P05])
- [ ] `bunx vite build` green; markdown + store unit tests green; no Rust warnings if any Rust touched.

**Acceptance tests:**
- [ ] `parseSlashCommandLine` unit suite (grammar + rejections).
- [ ] `CodeSessionStore` slot unit suite.
- [ ] Real-app end-to-end verification ([#step-5]).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] File-atomize a path argument ([Q03]).
- [ ] Keyboard activation / focus of the command span ([Q02]).
- [ ] Confirm/stash guard before clobbering a non-empty composer draft ([R01]).
- [ ] Consider `transferFocusForActivation` if a focus-save regression surfaces on cross-card clicks ([P06]).

| Checkpoint | Verification |
|------------|--------------|
| Enhancer + grammar | `bun test` grammar suite + `bunx vite build` |
| Visual affordance | app: hover only on known commands |
| Store slot | `bun test` store suite |
| End-to-end click | `/verify` drives click → composer → submit |
