<!-- devise-skeleton v4 -->

## Transcript Annotator {#transcript-annotator}

**Purpose:** Turn the Session card transcript into a hypertext document by introducing the **Transcript Annotator** — a library (`tugdeck/src/lib/annotator/`) that detects, tags, verifies, and services actionable entities (URLs, emails, slash/shell commands, file paths, atoms) in transcript ink through one model, one tagging pass, and one interaction registry. The existing `enhance-links` and `enhance-commands` passes are absorbed into it; file paths become clickable in prose, tool headers, atoms, and Glob/Grep path lists.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-31 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The transcript already has islands of actionability, each built ad hoc: `lib/markdown/enhance-links.ts` anchors scheme-bearing URLs and emails via linkifyjs; `lib/markdown/enhance-commands.ts` tags known slash commands and `just`/`tugutil` shell lines in inline code (class `tugx-md-cmd`) so a delegated click listener in `session-card-transcript.tsx` seeds them into the composer and the cell menu (`transcript-host-helpers.ts` → `useTranscriptCellMenu`) offers Copy items; `ToolFileRef` (`components/tugways/blocks/tool-file-ref.tsx`) makes the file path in Read/Edit/Write/NotebookEdit headers clickable with its own click handler and its own `TugContextMenu`. Meanwhile file paths in prose are inert, `PathListBlock` rows are explicitly display-only, atoms in the transcript are inert (except the leading submitted-command chip), and there is no shared entity model — adding a new actionable kind today means building a sixth one-off mechanism.

This phase replaces the one-offs with a library. An *annotation* is a first-class value — a kind plus a structured payload — detected by pure grammar modules, verified by asynchronous resolvers where the kind demands it (file existence via `POST /api/fs/stat`), stamped onto live DOM by one idempotent pass, and serviced by one delegated click listener and one context-menu provider driven by a per-kind registry. Prose entities and structured entities (tool headers, atom chips, path-list rows) converge on the same dataset contract, so they are indistinguishable at the interaction layer.

#### Strategy {#strategy}

- Build the annotator core first as a behavior-preserving absorption of `enhance-links` + `enhance-commands`, so the library exists and every later step is an addition to it, not a parallel system.
- Unify the interaction layer (registry + delegated listener + menu provider + dataset contract) before adding any new entity kind — new kinds then cost one detector + one registry entry.
- Add the file-path kind end-to-end (detector → resolver → tagging → actions) as the proving ground for the resolver layer; only *confirmed* paths get the affordance ([P05]).
- Converge the structured surfaces (`ToolFileRef`, atoms, `PathListBlock`) onto the dataset contract after prose works, one surface per step, each independently verifiable.
- Keep the two structural constraints inviolate throughout: all tagging is post-sanitize live-DOM work (DOMPurify strips `data-*`; see `lib/markdown/dompurify-instance.ts` `ALLOWED_ATTR`), and every pass is idempotent/re-runnable (streaming rewrites block `innerHTML` per delta; see `lib/markdown/render-incremental.ts` `buildBlockElement`/`updateBlockElement`).
- Defer entity kinds that need infrastructure this phase doesn't build: code symbols (needs an index — [Q01]), commit shas in prose (needs verification against git — [Q02]), free-prose path detection outside inline code ([Q03]).

#### Success Criteria (Measurable) {#success-criteria}

- A file path written by the assistant in inline code (e.g. `` `tugdeck/src/action-dispatch.ts` `` or `` `lib/foo.ts:212` ``) becomes clickable once verified to exist, opens the Text card at the cited line on click, and offers Open in Editor / Show in Finder / Copy Path / Insert into Composer on right-click. A path that does not exist on disk never gets the affordance. (Verify in the running app and by app-test.)
- Every behavior the absorbed passes provide today still works: scheme-bearing URLs and emails anchor and open via the host; known slash commands and `just`/`tugutil` lines are click-seedable into the composer; command right-click offers Copy / Copy as Plain Text; the catalog-arrival re-tag after a JSONL replay still tags late. (Existing tests migrate and pass; `just app-test-changed` passes.)
- `enhance-links.ts` and `enhance-commands.ts` no longer exist; `render-incremental.ts` calls exactly one annotator entry point where it called `enhanceLinks` + `enhanceCommands`. (Grep proof.)
- `PathListBlock` rows and transcript file atoms are click-openable and carry the same context menu as any other file-path annotation; link atoms carry the url annotation. (App-test / gallery verification.)
- Adding a hypothetical new kind requires touching only `lib/annotator/` (a detector and/or a registry entry) — no transcript, cell, or menu edits. (Code-review proof against the final structure.)
- `bunx vite build` succeeds (production-bundle gate) and `cd tugrust && cargo nextest run` stays green (no Rust changes expected, but the fs/stat contract is exercised).

#### Scope {#scope}

1. The annotator library: model, detectors, resolvers, tagging pass, interaction registry (`tugdeck/src/lib/annotator/`).
2. Absorption and deletion of `lib/markdown/enhance-links.ts` and `lib/markdown/enhance-commands.ts`, with their behavior and tests preserved.
3. The file-path and file-line-ref kinds with async existence verification against `POST /api/fs/stat`.
4. Interaction-layer unification: one delegated click listener, one menu provider, per-kind registry, new actions `INSERT_INTO_COMPOSER` and `COPY_ANNOTATION_VALUE`.
5. Structured-surface convergence: `ToolFileRef`, transcript atom chips (file and link types), `PathListBlock` rows.
6. V1 surfaces: prose (user + assistant markdown bodies), tool-call headers, transcript atoms, Glob/Grep path lists.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Code-symbol annotations (jump-to-definition) — tabled until a code-indexing facility exists; the registry/resolver shape is the extension point ([Q01]).
- Commit-sha annotations in prose, and click-through from `CommitShaText` to a commit view ([Q02]).
- Shell-route output rows and Bash tool output (terminal blocks) — deliberately excluded from v1 by the user.
- Free-prose (non-inline-code) file-path detection in text nodes ([Q03]).
- Fenced code blocks (`pre > code`) — inert, unchanged.
- "Run immediately" on a slash command's context menu — seeding the composer keeps the user in the loop.
- Any change to the fs/stat Rust endpoint — the existing contract suffices.

#### Dependencies / Prerequisites {#dependencies}

- `POST /api/fs/stat` (`tugrust/crates/tugcast/src/fs_stat.rs`) — batch existence probe, `kind: "file"` default, 64-path cap (`MAX_STAT_PATHS`), returns `exists` and `canonical` maps, rejects relative/traversing paths via `guard_absolute_path`. Already shipped; client precedent in `tugdeck/src/lib/dir-existence.ts`.
- `sessionMetadataStore` (`tugdeck/src/lib/session-metadata-store.ts`) — session `cwd` (nullable until the handshake/system_metadata lands) and the authoritative `slashCommands` catalog.
- `CodeSessionStore.insertSnippet(text, at)` (`tugdeck/src/lib/code-session-store.ts`) — the existing generic transcript→composer text channel; `at: null` appends.
- `openFileInCard` via `TUG_ACTIONS.OPEN_FILE` (`tugdeck/src/action-dispatch.ts`, registered with `{ path, line?, endLine? }` payload).

#### Constraints {#constraints}

- **Post-sanitize tagging only.** `SANITIZE_CONFIG.ALLOWED_ATTR` in `lib/markdown/dompurify-instance.ts` excludes `data-*`; every affordance dataset must be stamped on live DOM after `innerHTML` assignment.
- **Idempotent, re-runnable passes.** Streaming rewrites each changed block's `innerHTML` (`render-incremental.ts` `updateBlockElement`); the pass must be add/remove-correct when re-run over already-tagged DOM (the model `enhanceCommands` sets).
- **Reconciler skips stable blocks.** `planReconcile` leaves unchanged blocks untouched, so input-driven re-annotation (catalog arrival, resolver verdicts) cannot ride the reconciler — it needs the whole-container re-run effect (`tug-markdown-block.tsx`'s layout effect keyed on `isKnownSlashCommand` identity is the existing precedent).
- **Focus discipline.** A click that opens another card must not activate the host pane or steal DOM focus: `data-tug-focus="refuse"` + `data-no-activate` + `preventDefault` on primary mousedown (the `ToolFileRef` pattern; see also the mousedown-focus-default doctrine in `tuglaws`).
- **Warnings are errors**; `bunx vite build` must pass before a tugdeck change is done (debug app loads the production rollup bundle); bun, never npm.
- Tuglaws: [L02] external state via `useSyncExternalStore` only, [L03] `useLayoutEffect` for registrations events depend on, [L06] appearance via CSS/DOM never React state.

#### Assumptions {#assumptions}

- linkifyjs remains the URL/email grammar (MIT, vendored via lockfile); the annotator wraps it rather than re-implementing URL detection.
- The fs/stat 64-path batch cap is comfortably above any single transcript's distinct candidate-path count per probe cycle; the resolver chunks batches anyway.
- Assistant-written paths overwhelmingly appear in inline code spans (Claude's own convention), so inline-code-scoped path detection covers the real corpus.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Code-symbol annotations need an index (DEFERRED) {#q01-code-symbols}

**Question:** How do symbol mentions (function/type names) become jump-to-definition annotations?

**Why it matters:** It is the one entity kind with no backing lookup today; guessing produces broken links.

**Resolution:** DEFERRED by user decision. The annotator's shape is the guarantee: when an indexing facility exists, symbols become one detector + one resolver (candidate symbol → index lookup → confirmed with a target location) + one registry entry, with no annotator-core changes. Revisit when a code-index project lands.

#### [Q02] Commit-sha annotations (DEFERRED) {#q02-commit-shas}

**Question:** Should hex tokens in prose annotate as commit shas, and should `CommitShaText` click through to a commit view?

**Why it matters:** A 7–40-char hex word in prose is a high-false-positive grammar without verification against the repository, and there is no `open-commit` action in `action-vocabulary.ts` to click through to (grep confirms none exists).

**Resolution:** DEFERRED. Prose sha detection needs a git-backed resolver (a follow-on with the same resolver shape as [Q01]); click-through needs a commit-view addressing action that the Changeset/History surfaces don't expose yet. `CommitShaText` keeps its existing `useCopyableText` copy menu unchanged this phase.

#### [Q03] Free-prose path detection (DEFERRED) {#q03-free-prose-paths}

**Question:** Should path-like tokens in bare text nodes (outside inline code) annotate?

**Why it matters:** Bare-prose path grammar is far more false-positive-prone (slashes in prose, dates, fractions); inline code is where the assistant actually writes paths.

**Resolution:** DEFERRED. V1 detects paths only in inline `<code>` spans whose entire text parses as a path reference ([P06]). The detector API takes a string and returns matches, so extending to text-node scanning later is a tagging-layer change only.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Path false positives annotate junk | med | med | Existence verification gates the affordance ([P05]); whole-span inline-code grammar ([P06]) | User reports a bogus clickable path |
| Behavior regression while absorbing enhance passes | high | med | Behavior-preserving Step 1 with migrated tests; class/dataset rename isolated in Step 2 | Any migrated test fails |
| `ToolFileRef` convergence loses focus discipline | med | med | The tagging layer stamps the same focus attrs; delegated mousedown handler preventDefaults for open-kind annotations (Spec S01) | Composer loses caret on header click |
| Probe traffic on large transcripts | low | low | Session-scoped verdict cache, per-cycle dedup, 64-path chunks, candidates collected per container not per block | Probe latency visible in dev panel |
| Re-annotation effect thrash | med | low | One version number over all annotator inputs (catalog + resolver), `useSyncExternalStore`-driven, whole-container pass is bounded and idempotent | Perf telemetry shows annotate hot |

**Risk R01: App-test churn on the class rename** {#r01-app-test-churn}

- **Risk:** `tugx-md-cmd` is referenced by the gallery copy fixture (`components/tugways/cards/gallery-transcript-copy.tsx`) and by app-tests keyed to it; renaming breaks them silently if missed.
- **Mitigation:** Step 2 greps the whole repo for `tugx-md-cmd` and updates every reference in the same commit; `just app-test-changed` resolves the affected tests via `@covers`.
- **Residual risk:** An app-test outside the `@covers` resolution set that hard-codes the class; the Step 10 integration checkpoint's selective run is the backstop.

---

### Design Decisions {#design-decisions}

#### [P01] One annotation model, one dataset contract (DECIDED) {#p01-annotation-model}

**Decision:** Every actionable entity is an *annotation* — `{ kind, payload, state }` — represented in the DOM by the class `tugx-annotation` plus `data-tug-annotation="<kind>"` and per-kind payload attributes (Spec S01), regardless of whether it was detected in prose or stamped by a structured component.

**Rationale:**
- One interaction layer can service everything only if everything speaks one contract.
- Dataset attributes survive `innerHTML`-adjacent DOM work and are cheap to sample from delegated listeners via `closest()` — the mechanism `tugx-md-cmd` already proves.

**Implications:**
- The `tugx-md-cmd` class and its scattered references are renamed/absorbed (Step 2).
- Structured components (`ToolFileRef`, atom hosts, path-list rows) stamp the dataset instead of owning handlers.

#### [P02] The annotator absorbs enhance-links and enhance-commands (DECIDED) {#p02-absorb-enhance-passes}

**Decision:** `annotateTranscript` replaces both `enhanceLinks` and `enhanceCommands` in the enhance roster; the two source files are deleted; their grammars (`parseSlashCommandLine`, `parseShellCommandLine`, the linkifyjs configuration with the `HAS_URL_SCHEME` validate gate) move into `lib/annotator/` intact.

**Rationale:**
- User decision: the concepts survive and expand; three parallel systems is the outcome this project exists to prevent.
- The absorbed code embodies hard-won constraints (scheme gate against `.md` "domains", grammar-then-predicate ordering, add/remove idempotence) that must carry over verbatim.

**Implications:**
- `RenderIncrementalOptions.isKnownSlashCommand` is replaced by an `annotation?: AnnotationContext` option (Spec S04); `tug-markdown-block.tsx`'s `predicateRef` and re-run effect generalize to the context.
- Tests in `lib/markdown/__tests__/enhance-commands.test.ts` migrate to `lib/annotator/__tests__/`.

#### [P03] URLs and emails keep producing real anchors (DECIDED) {#p03-urls-stay-anchors}

**Decision:** The url/email kinds continue to produce plain `<a class="tugx-md-autolink">` anchors with no `target`/`rel` (linkify-element output), *additionally* stamped with the annotation dataset; primary click remains native anchor navigation intercepted by the macOS host's `WKNavigationDelegate` (`tugapp/Sources/MainWindow.swift`) which routes external URLs to `NSWorkspace`.

**Rationale:**
- The host-nav path is proven, zero-JS, and behaviorally correct; replacing it with a JS click handler would be regression risk for no gain.
- The dataset stamp is what the menu provider needs (Copy Link / Copy Address / Insert into Composer); the click needs nothing new.

**Implications:**
- The delegated click listener ignores url/email kinds (anchor default handles them); anchor tagging runs for **all** markdown consumers (as `enhanceLinks` does today, unconditionally), while non-anchor kinds tag only when an `AnnotationContext` is supplied.

#### [P04] Registry-driven interaction: one listener, one menu provider (DECIDED) {#p04-interaction-registry}

**Decision:** A per-kind registry (`lib/annotator/registry.ts`) maps kind → `{ primaryClick?(payload, ctx), menuEntries(payload) }`. The transcript root's single delegated click listener (`session-card-transcript.tsx`, currently the `.tugx-md-cmd` listener) and the cell menu's `extraEntries`/`hideStandardItems` provider (`transcript-host-helpers.ts` `useTranscriptCellMenu`) both resolve `event.target.closest('.tugx-annotation')` and dispatch through the registry.

**Rationale:**
- Adding a kind must cost zero transcript/cell edits — that is the library promise.
- The delegated-listener + menu-sampled-ref pattern already exists and is app-tested; this generalizes rather than replaces it.

**Implications:**
- The `contextCommandRef` sampling pattern generalizes to a `contextAnnotationRef` holding the sampled kind + payload at menu-open time.
- Registry click handlers receive a context carrying `deck`, `cardId`, and `codeSessionStore` (what the current listener closes over) so command seeding and file opening stay possible.
- Standard-menu suppression becomes a per-kind registry property rather than a blanket rule (`suppressStandardItems`, Spec S04) — the command kinds keep today's replace-the-menu behavior; other kinds append, so no selection-menu regression.

#### [P05] File paths verify asynchronously; only confirmed paths are actionable (DECIDED) {#p05-async-verification}

**Decision:** Path candidates detected in prose are probed in batches against `POST /api/fs/stat` (kind `file`, the default); only paths that exist get the annotation affordance, stamped with the endpoint's canonical form. Relative candidates resolve against `sessionMetadataStore.cwd` before probing; with no cwd yet, they stay unprobed candidates until the cwd lands.

**Rationale:**
- User decision. A link that works when clicked is the promise of the feature; the endpoint's `canonical` map also gives Text-card dedup the path form it wants.
- The endpoint rejects relative paths (`guard_absolute_path`), so client-side cwd resolution is mandatory anyway.

**Implications:**
- A resolver store with a session-scoped verdict cache and a subscription (Spec S03); verdict arrival bumps the annotation-inputs version and re-runs the pass (the catalog-arrival precedent).
- Structured sources (tool headers, path-list rows, atoms) are born confirmed — the tool already touched those paths — and never probe.

#### [P06] Inline code only; whole-span matching (DECIDED) {#p06-inline-code-only}

**Decision:** Prose path detection runs over inline `<code>` spans whose *entire* text parses as a single path reference (Spec S02); `pre > code` subtrees stay inert; bare text nodes are not scanned for paths ([Q03]).

**Rationale:**
- User decision (inline code entities in, block-level code out), and it mirrors the command pattern: whole-span matching is what keeps `enhanceCommands` false-positive-free.
- URL/email text-node scanning continues unchanged (linkifyjs already owns that surface well).

**Implications:**
- A `<code>` span is classified once per pass: slash command, else shell command, else path reference, else plain — mutually exclusive, in that precedence order.

#### [P07] Structured surfaces stamp the dataset and shed bespoke handlers (DECIDED) {#p07-structured-convergence}

**Decision:** `ToolFileRef` drops its own `onClick`/`TugContextMenu` and stamps the file-path dataset (born confirmed, with its `line`/`range` payload); transcript atom chip hosts (`tug-atom-markdown-body.tsx` `injectAtomHosts`) stamp `file`-type atoms as file-path annotations and `link`-type atoms as url annotations (the atom type vocabulary is `file` / `image` / `command` / `doc` / `link` — there is no directory type); `PathListBlock`'s `PathCell` rows stamp their paths. All are then serviced by the delegated layer.

**Rationale:**
- One interaction path for all file references is the convergence payoff; `ToolFileRef` events bubble to the transcript root and the cell menu, so the delegated layer covers header ground today.
- Cashes in `PathListBlock`'s explicitly deferred "make rows interactive" follow-on (its module docstring).

**Implications:**
- The tagging layer, not each component, stamps the focus-discipline attributes (`data-tug-focus="refuse"`, `data-no-activate`) on open-kind annotations, and the delegated mousedown handler preventDefaults primary presses on them (Spec S01) — preserving `ToolFileRef`'s exact protections.
- `ToolFileRef` keeps its visual identity (`tool-file-ref` class, glyph, `data-tugx-findable`, `MiddleEllipsisPath` siblings unaffected).

#### [P08] Insert into Composer rides `insertSnippet` (DECIDED) {#p08-insert-into-composer}

**Decision:** A new chain action `INSERT_INTO_COMPOSER` (`"insert-into-composer"`, payload `value: string`) is handled by the transcript cell's responder (beside `COPY_COMMAND` in `useTranscriptCellMenu`'s `useResponder` actions) and calls `codeSessionStore.insertSnippet(value, null)` after `deck.activateCard(cardId)`.

**Rationale:**
- `insertSnippet` already exists as the generic composer text channel (the Lens snippet path); no new store surface needed.
- Every annotation kind gains "send this back into the conversation" for one registry line each.

**Implications:**
- `action-vocabulary.ts` grows `INSERT_INTO_COMPOSER` and `COPY_ANNOTATION_VALUE` (`"copy-annotation-value"` — plain-text copy of the sampled annotation's canonical value, the generalization of `COPY_COMMAND_AS_PLAIN_TEXT` for non-command kinds; command kinds keep their existing backticked `COPY_COMMAND` flavor).

#### [P09] Re-annotation via one inputs-version effect (DECIDED) {#p09-reannotation-effect}

**Decision:** `TugMarkdownBlock`'s existing catalog re-run effect (a `useLayoutEffect` keyed on `isKnownSlashCommand` identity that re-runs `enhanceCommands` over the container) generalizes to: subscribe to the `AnnotationContext`'s inputs version (slash-catalog identity + resolver verdict version) via `useSyncExternalStore`, and re-run `annotateTranscript` over the container when it changes.

**Rationale:**
- The reconciler skips stable blocks by design ([#constraints]), so input-driven re-tagging must be a whole-container pass — exactly how the catalog case already works.
- One version over all inputs means one effect, no per-kind effect proliferation.

**Implications:**
- The pass must remain cheap and idempotent over already-annotated DOM (add/remove semantics per kind, the `enhanceCommands` model).

---

### Deep Dives {#deep-dives}

#### Current wiring the plan rewires {#current-wiring}

- **Enhance roster** (`lib/markdown/render-incremental.ts`, `buildBlockElement` / `updateBlockElement`): `enhanceFencedCode`, `enhanceImg`, `enhanceLinks`, `enhanceTable`, `enhanceMath`, `enhanceMermaid`, then `enhanceCommands` gated on the `isKnownSlashCommand` option. After this plan: `enhanceLinks`+`enhanceCommands` are replaced by `annotateTranscript(el, annotationContext?)` at the same roster position; anchor tagging (url/email) runs unconditionally, everything else only with a context.
- **Delegated command click** (`components/tugways/cards/session-card-transcript.tsx`, the `useLayoutEffect` registering a root `click` listener): samples `.tugx-md-cmd`, bails on a non-collapsed selection, then `deck.activateCard(cardId)` + `codeSessionStore.insertCommandDraft(name, args)` (slash) or `insertCommandDraft("shell", command)` (shell). Generalizes to registry dispatch on `.tugx-annotation` (Step 2), preserving the collapsed-selection bail.
- **Cell menu** (`components/tugways/cards/transcript-host-helpers.ts`, `useTranscriptCellMenu`): `extraEntries` samples `.tugx-md-cmd` into `contextCommandRef`, returns Copy / Copy as Plain Text (`COPY_COMMAND` / `COPY_COMMAND_AS_PLAIN_TEXT` handlers on the cell's responder), `hideStandardItems` suppresses the standard block on a command hit. Generalizes to registry-provided entries per sampled annotation (Step 2/3).
- **Submitted-command chip** (`components/tugways/cards/tug-atom-markdown-body.tsx`, `tagLeadingCommandHost`): stamps `COMMAND_CLASS` + `data-slash-command`/`data-slash-args` on the leading atom host via `buildSlashCommandLine` + `parseSlashCommandLine`. Migrates to stamping the annotation dataset (Step 2); the same function's neighborhood stamps file and link atom hosts in Step 8.
- **Known-command predicate** (`transcript-host-helpers.ts`, `useKnownSlashCommand`): live catalog (`sessionMetadataStore.slashCommands`) ∪ `LOCAL_SLASH_COMMANDS` via `useSyncExternalStore`, threaded into `TugMarkdownBlock`. Becomes one input of the `AnnotationContext`.
- **Catalog re-run effect** (`components/tugways/tug-markdown-block.tsx`, the layout effect keyed on `isKnownSlashCommand` that calls `enhanceCommands(el, isKnownSlashCommand)`): the template for the [P09] inputs-version effect. Note the block also holds `predicateRef` so streaming renders use the latest predicate without re-subscribing — the context object gets the same live-ref treatment.
- **`ToolFileRef`** (`components/tugways/blocks/tool-file-ref.tsx`): primary click filters `event.button !== 0 || metaKey || shiftKey`, dispatches `OPEN_FILE` with `range` (startLine/endLine, precedence over `line`); mousedown preventDefault under the same modifier filter; `TugContextMenu` items Open in Editor / Show in Finder as chain actions with the path as `value` (handled by `DeckCanvas`). All of this behavior transfers to the registry's file-path entry (Step 7); the modifier filters and the range-over-line precedence are part of Spec S01.
- **fs/stat client precedent** (`lib/dir-existence.ts`): fetch shape, best-effort empty-map degradation. The annotator's resolver follows the same transport conventions but keeps its own module (different caching/subscription needs).

#### Why the resolver is a store, not a per-call fetch {#resolver-store-rationale}

Streaming re-runs the pass per delta; a naive per-pass probe would re-fetch the same paths dozens of times. The resolver is a module-level store: candidates accumulate into a pending set, a microtask/short-debounce flush probes the deduped unknowns in ≤64-path chunks, verdicts land in a session-global cache keyed by the resolved absolute path, and a version counter + listener set drives [P09] re-annotation. Repeat candidates hit the cache synchronously, so steady-state passes do zero network work. `cwd` arriving later (it is `null` until the handshake) re-queues any relative candidates parked awaiting resolution.

---

### Specification {#specification}

**Spec S01: Annotation dataset contract** {#s01-dataset-contract}

Every annotated element carries class `tugx-annotation` and `data-tug-annotation="<kind>"`. Per-kind payload attributes:

**Table T01: Kinds, payloads, and interactions** {#t01-kind-table}

| Kind | Payload attributes | Primary click | Menu entries (beyond standard suppression) |
|------|--------------------|---------------|--------------------------------------------|
| `url` | (href on the anchor itself), or `data-url` on a non-anchor host (a link atom chip) | native anchor → host nav (unchanged); non-anchor hosts → `openUrlInOS(url)` (`lib/os-open.ts`) | Copy Link (`COPY_ANNOTATION_VALUE`), Insert into Composer |
| `email` | (mailto href on the anchor) | native anchor → mailto | Copy Address (`COPY_ANNOTATION_VALUE`), Insert into Composer |
| `slash-command` | `data-slash-command`, `data-slash-args` | activate card + `insertCommandDraft(name, args)` | Copy (`COPY_COMMAND`), Copy as Plain Text (`COPY_COMMAND_AS_PLAIN_TEXT`), Insert into Composer |
| `shell-command` | `data-shell-command` | activate card + `insertCommandDraft("shell", command)` | same as slash-command |
| `file-path` | `data-path` (canonical absolute), optional `data-line`, `data-end-line` | `dispatchAction({ action: OPEN_FILE, path, line?, endLine? })` | Open in Editor (`OPEN_FILE`), Show in Finder (`REVEAL_IN_FINDER`), Copy Path (`COPY_ANNOTATION_VALUE`), Insert into Composer |

Additional rules:

- Open-kind annotations (`file-path`) are also stamped `data-tug-focus="refuse"` and `data-no-activate`, and the delegated mousedown handler calls `preventDefault()` for a plain primary press on them (`button === 0`, no meta/shift) — the `ToolFileRef` focus discipline, applied at the tagging layer.
- Primary-click dispatch filters exactly as `ToolFileRef` does: plain button-0 only; modified clicks fall through so text selection works. The existing collapsed-selection bail (no seeding on a drag-select tail) applies to all kinds.
- `data-end-line` follows `ToolFileRef`'s precedence: a range's start/end wins over a bare line.
- `Insert into Composer` inserts the canonical value: the URL, the address, the command line (`/name args` with leading slash / the shell line), the path (with `:line` suffix when present).
- Menu composition is per-kind (`suppressStandardItems`, Spec S04): the command kinds *replace* the standard text-menu block (today's deliberate behavior — no selection-scoped Copy that would copy a smart-selected sub-word); url/email/file-path *append* their entries below the standard block, so right-clicking an annotation inside a text selection keeps Copy / Select All.
- Candidate (unverified) path spans carry **no** class and no dataset — an unverified path is visually and behaviorally plain text. Verification adds the annotation on the [P09] re-run; a verdict of missing leaves it plain forever (cached).

**Spec S02: Path-reference grammar (whole inline-code span)** {#s02-path-grammar}

A `<code>` span (not under `PRE`) whose entire trimmed text matches:

- *Path part:* absolute (`/…` with at least two segments) or relative with at least one interior `/` (e.g. `tugdeck/src/foo.ts`, `dash/plan.md`). Single-token names with no `/` (e.g. `package.json`) do **not** match in v1 — too ambiguous, and cwd-relative probing of bare names invites noise. Home-relative `~/…` forms do **not** match in v1 either: they are rare in transcript ink, the whitespace exclusion below already rejects most real ones (`~/Library/Application Support/…`), and supporting them would require a client-side home-derivation rule the phase doesn't need — a follow-on alongside [Q03].
- *Optional line suffix:* `:N` or `:N:C` (1-based; the column is parsed and discarded — `OPEN_FILE` takes lines).
- *Exclusions:* the span must not match the slash-command or shell-command grammar first (classification precedence, [P06]); text containing whitespace does not match; a `scheme://` prefix does not match (that's a URL); a leading `~` does not match (above).

The detector is pure: `detectPathReference(text: string): { path: string, line?: number, endLine?: number } | null`. Relative forms are *candidates* requiring cwd resolution + probe; absolute forms are candidates requiring probe only.

**Spec S03: Path resolution protocol** {#s03-path-resolution}

Module `lib/annotator/path-resolution.ts`, exporting a `PathResolutionStore` singleton-per-app:

- `lookup(rawPath, cwd | null): PathVerdict` — synchronous cache read. Verdicts: `unknown` (never seen — enqueues a probe), `pending` (probe in flight), `confirmed` (exists; carries the canonical absolute path from the endpoint's `canonical` map), `missing`.
- Resolution: relative candidates join against the session `cwd` (plain path join + normalization; the endpoint canonicalizes). A relative candidate with `cwd === null` stays `unknown` without enqueueing; the [P09] re-run after the cwd lands retries it. `~`-prefixed inputs never reach the store — the Spec S02 grammar rejects them.
- Probing: pending set flushed on a short debounce; deduped; chunked at 64 (`MAX_STAT_PATHS`); `POST /api/fs/stat` with `{ paths, kind: "file" }` (kind may be omitted — `File` is the serde default); transport failure degrades to re-queueable `unknown` (never to a false `confirmed`).
- `subscribe(listener)` / `version()` — the [P09] inputs. Cache is app-lifetime (paths churn slowly; Maker ▸ Reload rebuilds the world anyway).

**Spec S04: AnnotationContext and pass signature** {#s04-annotation-context}

```ts
interface AnnotationContext {
  isKnownSlashCommand: (name: string) => boolean;
  paths: PathResolutionStore;
  cwd: string | null;
}
annotateTranscript(container: HTMLElement, context?: AnnotationContext): void
```

- Without a context (every non-transcript markdown consumer): url/email anchor tagging only — the exact `enhanceLinks` behavior, preserving its `IGNORE_TAGS = ["A", "CODE", "PRE"]` and `HAS_URL_SCHEME` gate.
- With a context: additionally classify inline code spans (slash → shell → path precedence) and stamp/remove per Spec S01.
- `RenderIncrementalOptions` replaces `isKnownSlashCommand?: (name) => boolean` with `annotation?: AnnotationContext`; `renderIncrementalFromBlocks` threads it identically.
- The registry: `registerAnnotationKind(kind, { primaryClick?, menuEntries, suppressStandardItems })`, consulted by the transcript's delegated listener and menu provider with a dispatch context `{ deck, cardId, codeSessionStore }`. `suppressStandardItems: boolean` — whether a menu hit on this kind replaces the standard text-menu block (`true` for the command kinds, preserving today's deliberate behavior; `false` for url/email/file-path, whose entries append below the standard block so a right-click inside a selection keeps Copy/Select All).
- Pure decision core (the DOM-free functions bun tests pin, per #test-non-goals): `classifyInlineCode(text, isKnown, verdictLookup)` returns the kind + payload for a span's text or `null`; `payloadFromDataset(kind, record)` / `datasetForPayload(kind, payload)` round-trip payloads through plain string-record objects. The DOM pass and the delegated listeners are thin shells over these.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Annotation tags/affordances on ink | appearance | CSS + DOM dataset stamped by the pass | [L06] |
| Path verdict cache + version | external store | `PathResolutionStore` + `useSyncExternalStore` (inputs version in `TugMarkdownBlock`) | [L02] |
| Delegated listeners on transcript root | registration | `useLayoutEffect` (live before clicks) | [L03] |
| Sampled menu-target annotation | local-data | ref written at menu-open (`contextAnnotationRef`), read by handlers | (the `contextCommandRef` [L07] live-ref pattern) |
| Slash catalog | external store | existing `useKnownSlashCommand` (`useSyncExternalStore`) | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/annotator/types.ts` | `AnnotationKind`, payload types, `AnnotationContext`, dataset attr/class constants (`ANNOTATION_CLASS = "tugx-annotation"`) |
| `tugdeck/src/lib/annotator/annotate-transcript.ts` | The pass: anchor tagging (absorbed linkify config) + inline-code classification + stamp/remove |
| `tugdeck/src/lib/annotator/command-grammar.ts` | `parseSlashCommandLine`, `parseShellCommandLine`, moved from `enhance-commands.ts` verbatim |
| `tugdeck/src/lib/annotator/detect-path-reference.ts` | Spec S02 detector |
| `tugdeck/src/lib/annotator/path-resolution.ts` | Spec S03 store |
| `tugdeck/src/lib/annotator/registry.ts` | Kind registry + built-in entries (Table T01) |
| `tugdeck/src/lib/annotator/__tests__/…` | Migrated + new unit tests (bun test) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `annotateTranscript` | fn | `lib/annotator/annotate-transcript.ts` | replaces `enhanceLinks` + `enhanceCommands` in the roster |
| `AnnotationContext` | interface | `lib/annotator/types.ts` | Spec S04 |
| `PathResolutionStore` | class | `lib/annotator/path-resolution.ts` | Spec S03 |
| `detectPathReference` | fn | `lib/annotator/detect-path-reference.ts` | Spec S02 |
| `registerAnnotationKind` / `annotationEntryFor` | fn | `lib/annotator/registry.ts` | [P04] |
| `RenderIncrementalOptions.annotation` | field | `lib/markdown/render-incremental.ts` | replaces `isKnownSlashCommand` |
| `TUG_ACTIONS.INSERT_INTO_COMPOSER`, `TUG_ACTIONS.COPY_ANNOTATION_VALUE` | const | `components/tugways/action-vocabulary.ts` | [P08] |
| `TugMarkdownBlock` annotation prop + inputs-version effect | component | `components/tugways/tug-markdown-block.tsx` | [P09]; generalizes `predicateRef` + the catalog re-run effect |
| `useTranscriptCellMenu` registry-driven entries | hook | `components/tugways/cards/transcript-host-helpers.ts` | [P04]; `contextAnnotationRef` |
| transcript delegated annotation listener | effect | `components/tugways/cards/session-card-transcript.tsx` | generalizes the `.tugx-md-cmd` click effect |
| `ToolFileRef` (handler removal, dataset stamp) | component | `components/tugways/blocks/tool-file-ref.tsx` | [P07] |
| `PathCell` dataset stamp | renderer | `components/tugways/body-kinds/path-list-block.tsx` | [P07] |
| atom-host stamping (extends `tagLeadingCommandHost` neighborhood) | fn | `components/tugways/cards/tug-atom-markdown-body.tsx` | [P07] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun test)** | Pure logic only: grammars (path/command detection edge cases), the URL validate gate, payload extraction/composition over plain dataset records, resolver batching/dedup/cwd-join/verdict-transition logic | every pure module |
| **App-test (selective)** | Real click/menu round trips: command seeding still works, a confirmed path opens the Text card, `PathListBlock` row click, `ToolFileRef` post-convergence | Steps 2, 6, 7, 9 via `just app-test-changed` |
| **Build gate** | `bunx vite build` — production-bundle import health | every step touching tugdeck |

#### What stays out of tests {#test-non-goals}

- Mocked-fetch resolver tests — banned pattern (real, not fake); the resolver's pure logic (batch partitioning, cwd resolution, cache transitions) is unit-tested and the network path is covered by the app-test driving the real tugcast endpoint.
- **Any fake-DOM test** — no jsdom / happy-dom, period; the policy is stated verbatim in the header of `lib/markdown/__tests__/enhance-commands.test.ts` ("validated in the real app… not via fake-DOM render tests"). The `annotateTranscript` DOM pass (tagging, idempotence, stamp/unstamp) is therefore validated exclusively through app-tests and the gallery fixture; bun tests pin the pure functions the pass calls. To keep that split honest, the pass's decision logic is factored pure: classification (`classifyInlineCode(text, isKnown, verdictLookup) → kind + payload | null`) and dataset round-tripping (`payloadFromDataset(kind, record)` / `datasetForPayload(kind, payload)` over plain string-record objects, no DOM types).
- jsdom/fake render tests of React components — banned; component behavior is covered by app-tests against the real app.
- Host `WKNavigationDelegate` URL routing — unchanged by this plan, already exercised.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Only the user commits (project git policy); each step ends by reporting its proposed commit message.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Annotator core absorbs the enhance passes | done | `6136cda9b` |
| #step-2 | Dataset contract + registry + delegated interaction | done | `d824c7516` |
| #step-3 | Composer/copy actions for every kind | done | `e78e983f1` |
| #step-4 | Path-reference detector | done | `c3d515017` |
| #step-5 | Path resolution store | done | `913335648` |
| #step-6 | File-path annotations in prose, end-to-end | done | `94901faea` |
| #step-7 | ToolFileRef convergence | done | `f9ea6dee9` |
| #step-8 | Atom convergence | done | `6566f3d5a` |
| #step-9 | PathListBlock rows | done | `ebf5b4679` |
| #step-10 | Integration checkpoint | done | verification only |

#### Step 1: Annotator core absorbs the enhance passes {#step-1}

**Commit:** `tugdeck(annotator): found the annotator library; absorb enhance-links and enhance-commands`

**References:** [P02] Absorb enhance passes, [P03] URLs stay anchors, Spec S04, (#current-wiring, #constraints)

**Artifacts:**
- `lib/annotator/types.ts`, `lib/annotator/annotate-transcript.ts`, `lib/annotator/command-grammar.ts`, migrated tests.
- `enhance-links.ts` and `enhance-commands.ts` deleted; `render-incremental.ts` roster updated.

**Tasks:**
- [ ] Create `lib/annotator/` with `types.ts` (kinds, `AnnotationContext`, constants) and `command-grammar.ts` (move `parseSlashCommandLine` / `parseShellCommandLine` and their regexes verbatim from `enhance-commands.ts`).
- [ ] Write `annotateTranscript(container, context?)`: the linkify-element call with the exact `LINKIFY_OPTS` from `enhance-links.ts` (scheme gate, `tugx-md-autolink` class, ignore tags), then — only with a context — the inline-code classification loop from `enhanceCommands` (same add/remove semantics, same `PRE` skip). This step keeps stamping the **old** class/dataset (`tugx-md-cmd`, `data-slash-command`, …) so behavior is bit-identical; the contract flip is Step 2.
- [ ] Swap the roster in `render-incremental.ts` (`buildBlockElement` + `updateBlockElement`): replace the `enhanceLinks` + gated `enhanceCommands` calls with `annotateTranscript(el, options?.annotation)`; replace `RenderIncrementalOptions.isKnownSlashCommand` with `annotation?: AnnotationContext` (context carries the predicate; `paths`/`cwd` may be stubbed as absent-tolerant this step).
- [ ] Update the callers that pass the predicate: `tug-markdown-block.tsx` (prop becomes the context; `predicateRef` becomes a context live-ref; the catalog re-run effect calls `annotateTranscript`), `tug-atom-markdown-body.tsx` (imports `COMMAND_CLASS`/`parseSlashCommandLine` from their new homes), `transcript-host-helpers.ts` / `session-card-transcript.tsx` (import paths only this step).
- [ ] Delete `enhance-links.ts` and `enhance-commands.ts`; migrate `lib/markdown/__tests__/enhance-commands.test.ts` to `lib/annotator/__tests__/annotate-transcript.test.ts` unchanged in substance.

**Tests:**
- [ ] Migrated command-grammar tests pass against the new module (pure grammars only — the migrated file already excludes DOM coverage by policy).
- [ ] New pure test: the URL validate gate (the `HAS_URL_SCHEME` check, exported as a pure predicate from the annotator) accepts `https://status.claude.com` and rejects bare hosts like `tuglaws.md` — the enhance-links contract, pinned without DOM. Anchor behavior itself stays app-verified (Step 10).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/annotator`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `rg "enhance-links|enhance-commands" tugdeck/src` → no hits.

---

#### Step 2: Dataset contract + registry + delegated interaction {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(annotator): one dataset contract and a kind registry behind one delegated interaction layer`

**References:** [P01] Annotation model, [P04] Interaction registry, Spec S01, Table T01, Risk R01, (#current-wiring)

**Artifacts:**
- `lib/annotator/registry.ts` with slash-command / shell-command / url / email entries; `tugx-annotation` class live everywhere `tugx-md-cmd` was.

**Tasks:**
- [ ] Add the registry (Spec S04 shape) and register the command kinds (click behavior moved verbatim from the transcript listener) and url/email (no `primaryClick`; menu entries land in Step 3).
- [ ] Flip the pass to the Spec S01 contract: class `tugx-annotation` + `data-tug-annotation` kind attr (payload attrs unchanged for commands); anchors additionally stamped url/email kinds.
- [ ] Generalize the transcript delegated click effect in `session-card-transcript.tsx`: `closest('.tugx-annotation')` → registry `primaryClick` with `{ deck, cardId, codeSessionStore }`; keep the collapsed-selection bail; add the delegated `mousedown` preventDefault for open-kind annotations (no-op until Step 6 introduces one).
- [ ] Generalize `useTranscriptCellMenu`: `contextCommandRef` → `contextAnnotationRef` (kind + payload + element text sampled at menu open); `extraEntries` returns the registry's `menuEntries` for the sampled kind; `hideStandardItems` consults the sampled kind's `suppressStandardItems` (commands suppress as today; every other kind appends — Spec S01 menu-composition rule).
- [ ] Update `tagLeadingCommandHost` in `tug-atom-markdown-body.tsx` to stamp the new contract.
- [ ] `rg -l "tugx-md-cmd"` across the repo and update every reference: `tug-markdown-view.css` (the `.tugx-md-cmd` rule), `tug-atom-markdown-body.css`, `gallery-transcript-copy.tsx`, and any app-test keyed on the class.

**Tests:**
- [ ] Unit (pure, no DOM): registry resolution per kind; `payloadFromDataset` / `datasetForPayload` round-trip over plain string records for every kind (see #test-non-goals for the pure-factoring contract).
- [ ] App-test (selection derived by `@covers`): command click-to-seed and command right-click copy still work against the renamed class — this is also where tagging idempotence is exercised (streaming re-renders re-run the pass on the same content).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/annotator`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`
- [ ] `rg "tugx-md-cmd" --iglob '!dash/**'` → no hits.

---

#### Step 3: Composer/copy actions for every kind {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(annotator): INSERT_INTO_COMPOSER and COPY_ANNOTATION_VALUE across annotation menus`

**References:** [P08] insertSnippet channel, Spec S01, Table T01, (#current-wiring)

**Artifacts:**
- Two new actions in `action-vocabulary.ts`; responder handlers in `useTranscriptCellMenu`; url/email/command menus per Table T01.

**Tasks:**
- [ ] Add `INSERT_INTO_COMPOSER: "insert-into-composer"` and `COPY_ANNOTATION_VALUE: "copy-annotation-value"` to `TUG_ACTIONS` with payload docs (value = canonical annotation value), in the vocabulary's documented style.
- [ ] Handlers on the cell responder (beside `COPY_COMMAND` in `useTranscriptCellMenu`): copy writes plain text via the existing `writeCopyClipboard(value, null)` helper; insert does `deck.activateCard(cardId)` + `codeSessionStore.insertSnippet(value, null)` — the deck/card/store references reach the hook the same way the click listener gets them (thread through the hook's arguments from the cell host).
- [ ] Registry menu entries: url → Copy Link + Insert into Composer; email → Copy Address + Insert into Composer; commands → existing two Copy items + Insert into Composer (inserts the full `/name args` or shell line).

**Tests:**
- [ ] Unit: canonical-value composition per kind (leading slash restored for slash commands, `:line` suffix for paths later).
- [ ] App-test: right-click a known slash command → Insert into Composer lands the text in the prompt editor (real store, real editor).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/annotator`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 4: Path-reference detector {#step-4}

**Depends on:** #step-1

**Commit:** `tugdeck(annotator): whole-span path-reference grammar`

**References:** [P06] Inline code only, Spec S02, [Q03], (#assumptions)

**Artifacts:**
- `lib/annotator/detect-path-reference.ts` + exhaustive unit tests.

**Tasks:**
- [ ] Implement `detectPathReference` per Spec S02: absolute / interior-slash relative; `:N` and `:N:C` suffixes; whitespace, scheme-prefixed, `~`-prefixed, and single-token inputs rejected.
- [ ] Table-driven tests over the real shapes this transcript corpus produces — accepts: `tugdeck/src/action-dispatch.ts`, `/Users/kocienda/Mounts/u/src/tugtool/justfile`, `lib/foo.ts:212`, `lib/foo.ts:12:5`, `dash/plan.md`, `a/b`; rejects: `package.json`, `foo.ts:12` (single token — the interior-`/` rule applies to the path part, line suffix or not), `/usage`, `https://x.y/z`, `and/or`, `~/anything`, `~/Library/Application Support/x` (whitespace *and* `~`).

**Tests:**
- [ ] The table above, both accept and reject columns.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/annotator/__tests__/detect-path-reference.test.ts`

---

#### Step 5: Path resolution store {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(annotator): batched fs/stat path resolution with a session verdict cache`

**References:** [P05] Async verification, Spec S03, (#resolver-store-rationale, #dependencies)

**Artifacts:**
- `lib/annotator/path-resolution.ts` (`PathResolutionStore`).

**Tasks:**
- [ ] Implement Spec S03: synchronous `lookup` with enqueue-on-unknown; debounce-flushed, deduped, 64-chunked `POST /api/fs/stat` probes (transport conventions per `lib/dir-existence.ts`); canonical-path capture from the response's `canonical` map; `subscribe`/`version`.
- [ ] cwd handling: relative-join rule per Spec S03; parked relative candidates re-enqueue when a lookup arrives with a non-null cwd.
- [ ] Failure honesty: transport error → candidates return to `unknown` (re-probeable), never `confirmed`.

**Tests:**
- [ ] Unit (pure logic, no fetch mocks): chunk partitioning at 64, dedup, cwd join, verdict transitions, version bumps on verdict arrival.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/annotator/__tests__/path-resolution.test.ts`

---

#### Step 6: File-path annotations in prose, end-to-end {#step-6}

**Depends on:** #step-2, #step-3, #step-5

**Commit:** `tugdeck(annotator): verified file paths in prose become links`

**References:** [P05] Async verification, [P06] Inline code only, [P09] Re-annotation effect, Spec S01, Spec S03, Spec S04, Table T01, (#current-wiring)

**Artifacts:**
- The file-path registry entry; the full `AnnotationContext` (predicate + `PathResolutionStore` + cwd) threaded from the transcript; the inputs-version re-run effect; CSS for path annotations.

**Tasks:**
- [ ] Registry entry per Table T01: `primaryClick` dispatches `OPEN_FILE` with `path`/`line`/`endLine` (modifier filter and range-over-line precedence per Spec S01); menu = Open in Editor / Show in Finder / Copy Path / Insert into Composer (the first two as the chain-action forms `ToolFileRef` uses today, path as `value`, handled by `DeckCanvas`).
- [ ] Extend the pass's inline-code classifier: slash → shell → path precedence; path candidates consult `context.paths.lookup(candidate, context.cwd)`; only `confirmed` stamps (canonical path into `data-path`, focus-discipline attrs per Spec S01); `missing`/`pending`/`unknown` leaves the span untouched and un-stamps a previously stamped span whose verdict flips.
- [ ] Build the context where the predicate is built today: `transcript-host-helpers.ts` beside `useKnownSlashCommand`, adding cwd from `sessionMetadataStore` (already a `useSyncExternalStore` consumer there) and the app's `PathResolutionStore`; thread through the cells into `TugMarkdownBlock`.
- [ ] Generalize `TugMarkdownBlock`'s catalog re-run effect to the [P09] inputs version: `useSyncExternalStore` over (resolver version, catalog identity, cwd) → layout effect re-runs `annotateTranscript(el, context)`.
- [ ] CSS in `tug-markdown-view.css` beside the command rule: hover underline + pointer cursor for `[data-tug-annotation="file-path"]`, visually consistent with the command affordance.

**Tests:**
- [ ] Unit (pure, no DOM): `classifyInlineCode` precedence (a span matching both shell and path shapes goes shell; slash beats both) driven by a plain verdict-lookup function primed with confirmed/missing/unknown answers — the stamp/unstamp *decision* pinned without touching DOM.
- [ ] App-test: assistant ink containing a real repo path in backticks becomes clickable and opens the Text card at the cited line; a nonexistent path stays plain (drive the real fs/stat endpoint). This is where the stamp-on-confirm / stays-plain-on-missing behavior is verified end to end.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/annotator`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 7: ToolFileRef convergence {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(annotator): ToolFileRef rides the annotation registry`

**References:** [P07] Structured convergence, Spec S01, Risk table (focus discipline), (#current-wiring)

**Artifacts:**
- `tool-file-ref.tsx` without `onClick`/`handleMouseDown`/`TugContextMenu`; dataset-stamped instead.

**Tasks:**
- [ ] `ToolFileRef` renders its span with the Spec S01 file-path dataset (born confirmed: `data-path` = its `path` prop, `data-line`/`data-end-line` from `line`/`range` with range precedence) and keeps `data-tugx-findable`, `title`, glyph, classes; remove the component's own click/mousedown handlers and the `TugContextMenu` wrapper (the delegated layer now supplies identical behavior — same actions, same labels).
- [ ] Verify the delegated mousedown preventDefault (Step 2) now covers the header press, and `data-no-activate`/`data-tug-focus="refuse"` still ride the element (stamped by the component alongside the dataset — structured stamp, not pass-visited).
- [ ] Confirm consumers need no changes: `read-tool-block.tsx`, `edit-tool-block.tsx`, `write-tool-block.tsx`, `notebook-edit-tool-block.tsx`.

**Tests:**
- [ ] App-test: header basename click opens the file at the edit's changed lines; right-click shows Open in Editor / Show in Finder / Copy Path / Insert into Composer; composer caret survives the click (the focus-discipline assertion).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 8: Atom convergence {#step-8}

**Depends on:** #step-6

**Commit:** `tugdeck(annotator): transcript file and link atoms become annotations`

**References:** [P07] Structured convergence, Spec S01, Table T01, (#current-wiring)

**Artifacts:**
- File atom chips in the transcript click-open and carry the file-path menu; link atom chips carry the url annotation.

**Tasks:**
- [ ] In `tug-atom-markdown-body.tsx`, where hosts are injected and the leading command host is tagged: stamp hosts whose atom is `type === "file"` with the file-path dataset (born confirmed — the atom's `value` is the path the user attached) plus the focus-discipline attrs, and hosts whose atom is `type === "link"` with the url dataset (`data-url` = the atom's `value`; the non-anchor primary-click path per Table T01 opens it via `openUrlInOS`).
- [ ] Mirror the stamp in the plain-text renderer `tug-atom-text-body.tsx` for parity (both transcript atom renderers, one behavior).
- [ ] Extend the url registry entry's `primaryClick` for non-anchor hosts: an annotated element with no enclosing `<a>` opens `data-url` through `openUrlInOS` (`lib/os-open.ts`); anchor hosts keep native navigation (no handler runs — [P03] unchanged).

**Tests:**
- [ ] App-test: submit a prompt with a file atom; in the transcript, click the chip → Text card opens; right-click → file menu; a link atom chip click opens the URL. (If the replay-session workspace timing makes this flaky per the transient-workspace precedent, cover the click path via the gallery fixture instead and note it.)

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 9: PathListBlock rows {#step-9}

**Depends on:** #step-6

**Commit:** `tugdeck(annotator): Glob and Grep path rows open on click`

**References:** [P07] Structured convergence, Spec S01, Table T01, (#current-wiring)

**Artifacts:**
- Interactive `PathCell` rows; the module docstring's "display-only" deferral cashed in.

**Tasks:**
- [ ] Stamp each `PathCell` row root (`.tugx-paths-row`) with the file-path dataset (born confirmed; Glob/Grep emit absolute paths) + focus-discipline attrs; add row hover/cursor affordance in `path-list-block.css` keyed on the annotation attr.
- [ ] Update the module docstring's "What this body kind does NOT do" list (rows are now interactive via the annotator; no bespoke handlers were added — the delegated transcript layer services them, which is why this stays true to [L11] "PathListBlock owns no responder").
- [ ] `SearchResultBlock` (grep content mode) is *not* changed this step — its rows are match-line-shaped, not path-shaped; note as a roadmap follow-on.

**Tests:**
- [ ] App-test: run a Glob in a session, click a result row → Text card opens that file; right-click → file menu.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 10: Integration checkpoint {#step-10}

**Depends on:** #step-2, #step-3, #step-6, #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every Success Criterion against the running debug app (real session: assistant-written path, URL, email, slash command, shell command; tool headers; a Glob; a file atom).
- [ ] Confirm the no-regression bar: catalog-late re-tag after Maker ▸ Reload (JSONL replay) still tags commands; streaming deltas never flash annotations off.
- [ ] Grep proofs: no `enhance-links`/`enhance-commands`/`tugx-md-cmd` references remain.

**Tests:**
- [ ] Full selective sweep: `just app-test-changed` over the cumulative diff.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/annotator`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`
- [ ] `cd tugrust && cargo nextest run -p tugcast` (fs/stat contract unchanged and green)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Transcript Annotator library servicing url, email, slash-command, shell-command, and file-path annotations across prose, tool headers, atoms, and path lists — with the legacy enhance passes deleted and every annotation offering direct (click) and indirect (context-menu) action.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All Success Criteria under (#success-criteria) verified as written.
- [ ] `lib/annotator/` is the only place a new entity kind would touch (reviewed against the final structure).
- [ ] No behavior regressions in the absorbed passes (migrated tests + app-tests green).

**Acceptance tests:**
- [ ] `cd tugdeck && bun test src/lib/annotator` green.
- [ ] `just app-test-changed` green over the full phase diff.
- [ ] `bunx vite build` green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Code-symbol kind once an indexing facility exists ([Q01]).
- [ ] Commit-sha kind with git-backed verification + a commit-view open action ([Q02]).
- [ ] Free-prose path detection in text nodes ([Q03]).
- [ ] `SearchResultBlock` match rows as `file-line-ref` annotations (Step 9 note).
- [ ] Shell-route rows and terminal blocks as annotation surfaces (user-excluded from v1).
- [ ] A `tuglaws/` doctrine page for the annotator once the shape has settled in use.

| Checkpoint | Verification |
|------------|--------------|
| Library green | `cd tugdeck && bun test src/lib/annotator` |
| Bundle green | `cd tugdeck && bunx vite build` |
| App behavior green | `just app-test-changed` |
