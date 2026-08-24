<!-- devise-skeleton v4 -->

## Entity Presentation — placed atoms, written mentions {#entity-presentation}

**Purpose:** Regularize how transcript entities are painted, per `dash/entity-presentation.md`: one detection gate for every surface, a resting underline as the Mention affordance, and one read-only atom skin for every placed value (Gazette refs, commit shas, tool headers). No gesture changes; `registry.ts` is untouched.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-13 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

A file path in the transcript can be painted four different ways, a commit sha three, and which one you get is decided by the container the entity arrived in — a fact about our plumbing the reader cannot see. The brief `dash/entity-presentation.md` replaces that with a rule about authorship: an **atom** is something someone *placed* (an `@`-mention, a tool's `file_path` field, an entry in a post's `refs` array) and renders as glyph + name, boxed only where manipulable in place; a **mention** is something someone *wrote* (characters in a sentence) and renders as those characters plus a 1px underline at `currentColor` 45% when a resolver confirms it. The brief's decisions [P01]–[P09] are settled (including on the bench card `gallery-entity-presentation`); this plan carries them to code.

Behavior is already right and stays untouched: `tugdeck/src/lib/annotator/registry.ts` owns every gesture (nine kinds, one delegated listener, one context-menu provider) and no step below edits it. Every change swaps which component or CSS rule paints a mark that is already stamped correctly.

#### Strategy {#strategy}

- **Detection first, appearance second.** Retire the `inCode` license and the per-surface `proseCitesPaths` flag before shipping the underline — the rule is only legible against a corpus of marks that is already consistent (the brief's one ordering constraint: W1 before W2).
- **CSS carries the Mention; a component carries the atom.** The resting underline is pure CSS keyed off the annotation dataset already on the DOM ([L06]); the read-only atom is one renamed, widened component (`ToolFileRef` → `TugAtomRef`) adopted by the Gazette refs row and the commit surfaces.
- **Measure the only step that can regress.** W1 widens prose path scanning to the Session card, the surface with the most ink. The standing cost pin (`at0309`) was deliberately deleted (commit `bcf6c6a1f`, 2026-08-02 — "not worth pinning"), so the step runs it as a **restored, uncommitted probe** before and after, plus reads the live `annotateCounters()` numbers; no standing cost test is re-added.
- **Doctrine lands with the code.** A new `tuglaws/entity-presentation.md` names placed-vs-written and the labeling rule as vocabulary.
- **The bench dies last.** `gallery-entity-presentation.tsx` + `.css`, its registration, and `at0381` are deleted as the final work item, per the brief: a bench that outlives its question becomes a second source of truth.

#### Success Criteria (Measurable) {#success-criteria}

- A path that resolves is marked, and looks the same, whether backticked, bare, or line-cited — on the Session card and in the Gazette alike (app-test assertion in `at0307`; visual check on both cards).
- An inline `<code>` span that resolves to nothing looks exactly as it does today (no underline, code tone unchanged — asserted by computed-style read in `at0346`).
- `grep -r proseCitesPaths tugdeck/src` returns nothing; `grep -rn isUnambiguousInProse tugdeck/src` returns nothing.
- Every placed value in read-only ink wears the read-only skin, and every commit atom's label reads `Commit <8-char sha>` (Gazette refs row, `/commit` receipt, History rows).
- No gesture changed: `git diff` for the phase shows zero edits to `tugdeck/src/lib/annotator/registry.ts`.
- The annotator's cost on the Session card shows no meaningful regression: restored `at0309` probe passes before and after W1, and `annotateCounters()` per-pass `totalMs` / `textNodes` are the same order of magnitude on the same transcript.
- The bench and its test are deleted: `gallery-entity-presentation.tsx`, `gallery-entity-presentation.css`, its `gallery-registrations.tsx` entry, and `tests/app-test/at0381-entity-presentation-bench.test.ts` all gone.

#### Scope {#scope}

1. W1 — one detection gate: retire `inCode` license, `proseCitesPaths`, and `isUnambiguousInProse`.
2. W2/W3 — resting underline CSS for confirmed Mentions; code tone and rule kept as independent channels.
3. W4 — `ToolFileRef` becomes the read-only atom skin (`TugAtomRef`); Gazette trailing refs adopt it.
4. W5 — widen the skin past `file-path`; `CommitShaText` renders the commit atom labelled `Commit <short>`.
5. W6 — doctrine into tuglaws.
6. Bench retirement (4 files).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Any change to `registry.ts`, click behavior, context menus, or the delegated listener.
- Changing the editable skin (`TugAtomChip` / `createAtomImgElement`) or where it appears (composer, user-message replay).
- Removing `unmentionedRefs` suppression in the Gazette — a ref already named in prose still should not also appear in the trailing row (brief [P06]).
- New theme tokens. The rule is `color-mix(in srgb, currentColor 45%, transparent)` — derived from the ink it underlines, no `--tug7-*` addition, no `audit:theme-contrast` exposure (brief, "Explicitly not a question").
- Re-adding a standing annotator-cost app-test (the user deleted `at0309` deliberately).
- Promoting the brief's decisions into global `[D##]` numbers in `tuglaws/design-decisions.md` — the new tuglaws doc carries the doctrine; global promotion can follow later if wanted.

#### Dependencies / Prerequisites {#dependencies}

- The brief: `dash/entity-presentation.md` (decisions [P01]–[P09], call-site inventory, retired alternatives).
- The bench card (`gallery-entity-presentation`) as the visual reference for the settled underline weight and the read-only refs row — consult it while it still exists; it is deleted in #step-7.
- Working tree currently has an unrelated modification (`tugdeck/src/components/tugways/session-identity-menu.tsx`) — leave it alone.

#### Constraints {#constraints}

- **Warnings are errors** across the workspace; deleting `proseCitesPaths` / `isUnambiguousInProse` must leave no unused imports, params, or fields (e.g. `collectTextNodes`' `inCode` plumbing in `wrap-matches.ts`).
- Verdicts land after ink is painted and must never reflow a streaming transcript — the resting signal must cost nothing in layout metrics (underline only; never borders, padding, or font changes on Mentions).
- App-tests are selective: `just app-test-changed` derives the run from `@covers`; never run the full corpus.
- Verify tugdeck changes with `bunx vite build` (the debug app loads the prod rollup bundle).
- Unit tests for the annotator live at `tugdeck/src/lib/annotator/__tests__/` and run with `bun test` from `tugdeck/`.
- Only the user commits on `main` — unless autonomous sub-step execution was explicitly authorized, in which case each step's `**Commit:**` message is the boundary.

#### Assumptions {#assumptions}

- `resolvePath` remains the real gate: permissive detection behind a strict confirm, so a wrong guess costs one cached lookup and text that stays text. This is how the Gazette has shipped since `proseCitesPaths` landed there, and it is the surface that reads best.
- `--tugx-block-code-font` is defined on `body` (`tugdeck/styles/tugx-block.css`), so the component-owned mono decision resolves on every surface.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the read-only skin carry the code font? (DECIDED) {#q01-skin-code-font}

**Question:** `ToolFileRef` sets `font-family: inherit`, which lands as mono in a tool header (the detail slot is already mono) and as *prose font* in the Gazette's trailing row.

**Resolution:** DECIDED (see [P03]) — the component pins mono itself: `font-family: var(--tugx-block-code-font, var(--tug-font-family-mono))`, decided once in `tug-atom-ref.css` rather than per consumer. The bench pinned `.gep-refs-unboxed` to mono precisely to make this visible; the answer is yes.

#### [Q02] Does `ToolFileRef` get renamed? (DECIDED) {#q02-rename}

**Question:** After W4/W5 the component is no longer "the thing in a tool header" — it is the read-only atom skin, widened past `file-path` to commits. The name will actively mislead.

**Resolution:** DECIDED (see [P03]) — renamed to `TugAtomRef`, file pair moved to `tugdeck/src/components/tugways/tug-atom-ref.tsx` + `.css`. Call sites are enumerated in #step-3; the rename is done in the same step that widens the API so the churn happens once.

#### [Q03] Copy round-trip for the relabelled commit atom (OPEN → verified in-step) {#q03-copy-round-trip}

**Question:** The Gazette row's label goes from `Commit: <8>` to `Commit <8>`, and `CommitShaText`'s right-click Copy already writes `Commit <8>` (`getText` in `commit-sha-text.tsx`). Do `copy-as-plain-text.ts` and `selectionToTranscriptMarkdown` (`tugdeck/src/lib/markdown/serialize-selection.ts`) yield one spelling, not two?

**Why it matters:** Two spellings of the same atom on the clipboard is the arbitrariness this whole phase retires, resurfacing in paste.

**Plan to resolve:** `copy-as-plain-text.ts` reads the DOM selection's text verbatim (no annotation awareness), so once the rendered label is `Commit <8>` everywhere placed, selection copy and menu copy converge by construction. #step-5 carries the explicit verification task: select across the Gazette refs row and a receipt header, assert one spelling in `at0366`-style copy assertions.

**Resolution:** OPEN until #step-5's checkpoint; the mechanism makes convergence automatic, the test makes it pinned.

#### [Q04] How is W1's cost measured now that `at0309` is deleted? (DECIDED) {#q04-cost-measurement}

**Question:** The brief instructs "read `at0309` before and after; a plan that does not is not done" — but `tests/app-test/at0309-annotator-cost.test.ts` was deleted in commit `bcf6c6a1f` (2026-08-02, "delete cost pin … not worth pinning"). The brief is stale on this point. (`at0310-commit-receipt-annotations.test.ts` from the brief's coverage list is likewise gone, deleted in `b80947798`; today's `at0310` is `at0310-file-view-open.test.ts`.)

**Resolution:** DECIDED (see [P05]) — restore the deleted test as an uncommitted probe (`git show bcf6c6a1f^:tests/app-test/at0309-annotator-cost.test.ts > tests/app-test/at0309-annotator-cost.test.ts`), run it before and after the W1 change, then delete the file without committing it. If the restored test no longer runs against current APIs (it was deleted alongside the `MISSING_ATTRIBUTE`/`MISSING_TITLE` removal and may probe attributes that no longer exist), fall back to its measurement substrate, which still ships: `annotateCounters()` in `tugdeck/src/lib/annotator/annotate-counters.ts` (`passes`, `contentPasses`, `totalMs`, `textNodes`), read via `evalJS` against a real populated transcript. Record both readings in the step's commit message. Do not re-commit a standing cost pin.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| W1 regresses annotator cost on the Session card | med | low | resolver answers are cached; before/after probe per [Q04]; per-container `data-tugx-awaiting` invalidation unchanged | probe shows super-linear pass growth or `totalMs` jump |
| Dense prose becomes a field of underlines | med | low | 45% weight settled on the bench against a six-mention paragraph; only resolver-confirmed runs are marked | user reaction to real transcripts |
| Two clipboard spellings for a commit | low | low | [Q03] verification task in #step-5 | copy assertion fails |
| Restored `at0309` probe doesn't run against current code | low | med | fallback to `annotateCounters()` via `evalJS`, per [Q04] | probe errors on restore |

**Risk R01: Session-card annotator cost** {#r01-annotator-cost}

- **Risk:** Deleting the prose license means every path-shaped token in every assistant paragraph asks `resolvePath` — the Session card carries far more ink than the Gazette.
- **Mitigation:** Answers are cached and detection was always permissive; the pass-count economy (per-container awaiting flags, `VerdictBatcher` coalescing) is untouched; measure per [Q04].
- **Residual risk:** More `fs/stat`-backed lookups on first paint of a long transcript; bounded by the resolution cache.

**Risk R02: Underline leaks onto non-Mention marks** {#r02-underline-scope}

- **Risk:** A session-kind wrapped span hosts a portaled citation chip (`session-citation-portals.tsx` empties the span, saving its words on `data-tugx-session-text`), and atom skins have their own affordances — a broad underline selector would decorate them wrongly.
- **Mitigation:** Selector lists Mention-carrying kinds explicitly and excludes `session` (see Spec S01); atoms (`.tug-atom-ref`, `.tug-atom-chip-host`) keep hover-only treatment and never match the Mention selectors.
- **Residual risk:** A future annotation kind must be added to the selector list; the tuglaws doc (#step-6) names this as the registration point.

---

### Design Decisions {#design-decisions}

> The brief's [P01]–[P09] are inherited wholesale and cited below as "brief [Pnn]". The decisions here are this plan's operational choices.

#### [P01] Detection gate is resolver-only, everywhere (DECIDED) {#p01-resolver-only-gate}

**Decision:** Delete the `licensed` check in `annotatePathsInText` (`annotate-content.ts`), the `proseCitesPaths` field (`annotator/types.ts`), and `isUnambiguousInProse` (`detect-path-reference.ts`), plus the now-unused `inCode` plumbing in `collectTextNodes` (`wrap-matches.ts`). Every scanned path candidate goes straight to `context.resolvePath`.

**Rationale:**
- Implements brief [P03]: `resolvePath` was always the real gate — permissive detection behind a strict confirm.
- Resolves the brief's A1 (backticks gate detection) and A4 (per-surface gate) in one deletion.
- The Gazette has shipped this way (`useGazetteAnnotation` sets `proseCitesPaths: true`) and reads best.

**Implications:**
- `useGazetteAnnotation` (`gazette-card.tsx`) drops the field; `useAnnotationContext` (`transcript-host-helpers.ts`) never set it and needs no edit — but the Session card's *behavior* changes, because the license disappears from the shared pass.
- The bench (`gallery-entity-presentation.tsx`) parameterizes `proseCitesPaths` and must be patched to keep compiling (its today/proposed detection difference collapses — acceptable, the bench has served that question and dies in #step-7).
- Unit tests for `isUnambiguousInProse` in `annotator/__tests__/detect-path-reference.test.ts` are deleted with the function.
- `annotateInlineCode` / `classifyInlineCode` are untouched — a whole `<code>` span that is exactly one path was never the license's subject.

#### [P02] The resting rule: underline, declared once per mark family (DECIDED) {#p02-resting-rule}

**Decision:** Confirmed Mentions get `text-decoration-line: underline; text-decoration-thickness: 1px; text-decoration-style: solid; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); text-underline-offset: 0.2em;` at rest. Hover keeps the existing full link treatment (`--tugx-md-link-color-hover` + `--tugx-md-link-decoration`), unchanged.

**Rationale:**
- Brief [P05]: an underline is the one signal already learned meaning *you can act on this*; 45% solid was settled on the bench (28% and 70% auditioned and rejected — recorded in `gallery-entity-presentation.css`).
- Brief [P04]: code tone (backticks) and the rule (verdict) are orthogonal channels; the underline adds to annotated inline `<code>` without touching its tone.
- Zero layout cost: `text-decoration` never reflows, so a late verdict never moves streaming ink.

**Implications:**
- `styles/tug-annotation.css` retires its "Resting-plain" doctrine paragraph; `tug-markdown-view.css` retires "resting appearance is the ordinary inline-code chip / resting-plain" comments on the command and file-path rules.
- Selector scope per Spec S01 — session-kind wraps excluded (they host chips), URL/email anchors excluded (already links).

#### [P03] `TugAtomRef` — one read-only atom skin, mono-pinned, presentation split from stamping (DECIDED) {#p03-tug-atom-ref}

**Decision:** Rename `ToolFileRef` to `TugAtomRef`, moving `tugdeck/src/components/tugways/blocks/tool-file-ref.tsx`/`.css` to `tugdeck/src/components/tugways/tug-atom-ref.tsx`/`.css`. The component gains: (a) a pinned code font (`var(--tugx-block-code-font, var(--tug-font-family-mono))`) so the skin reads identically on prose surfaces ([Q01]); (b) an explicit **label** (defaulting to the path basename for file atoms, `Commit <8>` for commit atoms per brief [P09]); (c) a **presentational mode** — when a host already owns the annotation stamping (the Gazette's `annotationProps` wrapper span) or owns its own gestures (`CommitShaText`), the skin renders without stamping its own dataset, so nothing double-stamps.

**Rationale:**
- Brief [P06]: `ToolFileRef` *is* the read-only atom — we built the same component twice without noticing; the name must stop saying "tool header" ([Q02]).
- The Gazette's wrapper span already carries the full annotation contract (`data-tug-annotation` + payload dataset + focus-refuse marks) and the pending/unresolvable tooltip states; making the skin re-stamp inside it would duplicate the contract.
- `Tug*` prefix and file-pair layout follow tugways component conventions ([L19]); it sits beside `tug-session-identity.tsx` and friends because its consumers now span tool blocks, Gazette, pulse, and commit surfaces.

**Implications:**
- Call sites to update (the complete list, from `grep -rn ToolFileRef tugdeck/src`): `cards/blocks/read-tool-block.tsx`, `cards/blocks/write-tool-block.tsx`, `cards/blocks/edit-tool-block.tsx`, `cards/blocks/notebook-edit-tool-block.tsx`, `pulse-beat-text.tsx`, and the bench (`cards/gallery-entity-presentation.tsx` — patched only enough to compile; it dies in #step-7).
- Tool-header usage keeps today's exact behavior: self-stamped `file-path` annotation, `data-tugx-findable`, `data-tug-focus="refuse"`, `data-no-activate`, `title` = full path.
- `at0307`'s `@covers` line naming `blocks/tool-file-ref.tsx` must be updated to the new path (`just app-test-covers-check` fails on a path that no longer resolves).

#### [P04] Commit atoms say `Commit <8>`, one spelling (DECIDED) {#p04-commit-label}

**Decision:** Every *placed* commit renders as the read-only atom with label `Commit ` + first 8 sha characters: the Gazette ref (today `Commit: <8>` — colon dropped), the `/commit` receipt header, and History rows. Display length stays unified on the existing constants (`SHA_DISPLAY_LEN = 8` in `commit-sha-text.tsx`, `COMMIT_LABEL_LENGTH = 8` in `lib/commit-format.ts` — note the brief's "Commit: <9>" mis-states today's length; it is already 8).

**Rationale:**
- Brief [P07]/[P09]: a sha in a receipt header or a `refs` array arrives in a field, so it is an atom; an atom stands with no sentence around it, so the word belongs in the label. A sha *written in prose* stays a Mention with no added word.
- `CommitShaText`'s right-click Copy already writes `Commit <8>` — the label converges on the spelling copy already uses.

**Implications:**
- Commit shas go from three forms to two positions: atom where placed, Mention where written.
- `CommitShaText` keeps its name, its gesture ownership (stopPropagation suite, copy menu), and its `content` prop (filter-match `<mark>`s decorate the sha characters within the label); only its rendering adopts the skin. See #step-5.

#### [P05] Cost is measured, not pinned (DECIDED) {#p05-cost-probe}

**Decision:** #step-1 measures the Session-card annotator cost before and after via the restored-`at0309` probe with the `annotateCounters()` fallback ([Q04]), records both readings in the commit message, and leaves no standing cost test behind.

**Rationale:**
- The brief demands the measurement; the user deliberately deleted the pin (`bcf6c6a1f`). Measuring without re-pinning honors both.

**Implications:**
- The probe file must never be committed; delete it before the step's commit.

#### [P06] Doctrine lives at `tuglaws/entity-presentation.md` (DECIDED) {#p06-tuglaws-doc}

**Decision:** W6 writes a new tuglaws doc carrying the placed-vs-written rule, the two-skins model, the two-channels model, the labeling rule, and the retired alternatives; `tuglaws/INDEX.md` gets its row. No global `[D##]` numbers are allocated in this phase.

**Rationale:**
- The brief's "Retired — do not re-propose" list is exactly the durable content tuglaws exists for; each entry is the obvious next idea for a cold reader.

**Implications:**
- CSS comments in `tug-annotation.css` / `tug-markdown-view.css` point at the doc instead of restating the doctrine.

---

### Deep Dives {#deep-dives}

#### Where each behavior lives today (investigation record) {#current-behavior-map}

Findings a cold implementer would otherwise re-derive:

- **The license being deleted** is the `licensed` expression in `annotatePathsInText` (`tugdeck/src/lib/annotator/annotate-content.ts`): `inCode || context.proseCitesPaths === true || isUnambiguousInProse(reference)`. `inCode` is computed per text node by `collectTextNodes` (`wrap-matches.ts`), which walks with a `visit(node, inCode || tagName === "CODE")` recursion; after W1 the flag has no consumer — remove the field from the `sites` entries and the recursion parameter, or `-D warnings`-equivalent lint fails the build.
- **`proseCitesPaths` setters:** only `useGazetteAnnotation` (`gazette-card.tsx`, in the context memo) and the bench's parameterized context builder (`gallery-entity-presentation.tsx`). `useAnnotationContext` (`transcript-host-helpers.ts`) never sets it.
- **`isUnambiguousInProse`** (`detect-path-reference.ts`): returns true for a line-cite or an absolute path. Deleted with its `describe` block in `annotator/__tests__/detect-path-reference.test.ts`.
- **Current resting-plain CSS:** `styles/tug-annotation.css` gives `[data-tugx-wrapped][data-tug-annotation]` only `cursor: pointer` at rest, hover adds link color + decoration. `tug-markdown-view.css` gives annotated inline `<code>` (`slash-command`, `shell-command`, `file-path` selectors around the "Clickable command" / "Verified file path" comments) the same hover-only treatment. These are the two files W2 edits; the hover rules stay verbatim.
- **The Gazette refs row:** `RefAtom` (`gazette-card.tsx`) renders `TugAtomChip` (fontSize 12, module const `GAZETTE_CHIP_FONT_SIZE`) inside a `<span {...annotationProps(chipRef, resolution)}>`. `annotationProps` stamps the full annotation contract for an actionable resolution and a reason tooltip otherwise. A session ref renders `TugSessionCitation` (`tug-session-identity.tsx`) and is untouched (brief [P08]). Row layout is `.gazette-post-refs` in `gazette-card.css` (flex, wrap, `--tug-space-xs` gap).
- **Commit surfaces:** `CommitShaText` (`commit-sha-text.tsx`) renders a bare `<code class="commit-sha-text">`; consumed by `session-commit-receipt-block.tsx` (the `/commit` receipt, deliberately *not* annotated — the component owns every pointer gesture) and `commit-presentation.tsx` (`CommitIdentity`, used by `tug-history-list.tsx` for History rows, wrapped in the entity `TugTooltip`).
- **Session citation portal invariant:** `useSessionCitationPortals` (`session-citation-portals.tsx`) empties the host span and preserves its words on `data-tugx-session-text` — the reason the underline selector must exclude `session` (an emptied span underlines nothing today, but the exclusion keeps the contract explicit).
- **The bench's settled values** (`gallery-entity-presentation.css`): rule = `text-decoration-line: underline` + `text-underline-offset: 0.2em` + color `color-mix(in srgb, currentColor 45%, transparent)`; the unboxed refs row pins `font-family: var(--tug-font-family-mono)`, `font-size: 0.9em`, muted color, `--tug-space-md` gap.
- **`--tugx-block-code-font`** is declared on `body` in `styles/tugx-block.css` (`var(--tug-font-family-mono)`), so [P03]'s font pin resolves everywhere.
- **Test reality vs the brief:** `at0309-annotator-cost.test.ts` deleted (`bcf6c6a1f`); `at0310-commit-receipt-annotations.test.ts` deleted (`b80947798`); current `at0310` is `file-view-open`. Live coverage today: `at0307-transcript-file-path-links` (Session-card path marking, `@covers tugdeck/src/lib/annotator/`), `at0346-annotation-atom-and-entity`, `at0365-gazette-card`, `at0366-gazette-copy`, `at0368-gazette-session-citations`, `at0381-entity-presentation-bench` (dies with the bench).

#### What W1 changes on the Session card, concretely {#w1-behavior-delta}

Today a Session-card assistant paragraph marks a path only if it is backticked (`inCode`), absolute, or line-cited. After W1, a bare relative path or filename in prose (`registry.ts` in a sentence) is scanned, sent to `resolvePath`, and — only if the resolver confirms a real file via the project's file index — marked. Unresolvable path-shaped words stay byte-identical plain text. The Gazette's rendering is unchanged (it already ran ungated); its only delta is W2's underline.

---

### Specification {#specification}

**Spec S01: Resting-rule selector scope** {#s01-underline-selectors}

In `styles/tug-annotation.css` (split-out runs — Mentions):

```css
/* @tug-renders-on: the surrounding surface's own background */
[data-tugx-wrapped][data-tug-annotation="file-path"],
[data-tugx-wrapped][data-tug-annotation="directory"],
[data-tugx-wrapped][data-tug-annotation="commit-sha"] {
  text-decoration-line: underline;
  text-decoration-style: solid;
  text-decoration-thickness: 1px;
  text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
  text-underline-offset: 0.2em;
}
```

In `tugdeck/src/components/tugways/tug-markdown-view.css` (annotated inline `<code>` — code tone *plus* the rule, brief [P04]): the same declaration block for `.tugx-md-block code[data-tug-annotation="slash-command"]`, `...="shell-command"`, `...="file-path"`, `...="directory"`.

There is deliberately **no** `code[data-tug-annotation="commit-sha"]` selector: `classifyInlineCode` (`payloads.ts`) can only stamp `slash-command` / `shell-command` / `file-path` / `directory` on a whole `<code>` span. A backticked sha reaches the DOM as a *wrapped run inside* the code element (the text scan descends into unannotated `<code>`), so the `[data-tugx-wrapped]` block above already covers it.

Per [L16], every new color-setting rule carries an `@tug-renders-on` comment naming its rendering surface, matching each sheet's existing convention (the wrapped-run hover rule in `tug-annotation.css` shows the format).

Exclusions, by construction: `session` wraps (portal hosts, chip carries the affordance), `url`/`email` (anchors, already links), atoms (`.tug-atom-ref`, `.tug-atom-chip-host` — hover-only, unchanged). Hover rules in both files stay exactly as shipped. An inline `<code>` span with **no** `data-tug-annotation` (a resolver refusal or an identifier) matches nothing and keeps today's look — that is success criterion 2.

**Spec S02: `TugAtomRef` API** {#s02-tug-atom-ref-api}

```tsx
// tugdeck/src/components/tugways/tug-atom-ref.tsx
export interface TugAtomRefProps {
  /** Glyph + label; label defaults per entity, per brief [P09]. */
  entity:
    | { kind: "file"; path: string; line?: number; range?: { startLine: number; endLine: number } }
    | { kind: "commit"; sha: string };
  /** Override the default label (basename / `Commit <8>`). Rendered children
   *  MUST read as the same characters — decoration, never substitution. */
  label?: React.ReactNode;
  icon?: React.ReactNode;      // default: FileText for file, GitCommit for commit
  /** Stamp the annotation dataset + focus-refuse marks on the skin itself
   *  (tool headers, pulse). false when a host wrapper owns the contract
   *  (Gazette annotationProps span) or owns its own gestures (CommitShaText). */
  annotate?: boolean;          // default true for file, false for commit
  title?: string;              // default: full path for file, undefined for commit
  "data-slot"?: string;
  className?: string;
}
export function fileRefBasename(path: string): string; // kept, re-exported
```

CSS (`tug-atom-ref.css`): today's `tool-file-ref` rules with class names renamed to `tug-atom-ref` / `tug-atom-ref-icon`, plus the [Q01] font pin `font-family: var(--tugx-block-code-font, var(--tug-font-family-mono))` replacing `font-family: inherit` (`font-size`/`color: inherit` stay — consumers size it; the Gazette row sets its own size, see #step-4). The `@tug-pairings` header comment is updated for the new consumers.

**Link affordance follows the annotation contract, not a class.** The `tool-file-ref--link` class is retired. Cursor + hover underline key off the presence of `data-tug-annotation` — on the skin itself (annotate mode, tool headers) or on its immediate wrapper (presentational mode, the Gazette's `annotationProps` span):

```css
/* Affordance rides the annotation contract: an annotated skin (or a skin
   inside an annotated wrapper) is clickable; an unresolvable ref carries
   no annotation and invites nothing. Same move tug-atom-markdown-body.css
   makes for chips — "annotated" and "actionable" are the same fact. */
.tug-atom-ref[data-tug-annotation],
[data-tug-annotation] > .tug-atom-ref {
  cursor: pointer;
}
.tug-atom-ref[data-tug-annotation]:hover,
[data-tug-annotation] > .tug-atom-ref:hover {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}
```

This is what keeps a dead Gazette ref honest for free: `annotationProps` stamps the wrapper only when `resolution.state === "actionable"`, so a pending or unresolvable ref renders the skin with no cursor, no hover, and only the reason tooltip — no prop threading, no per-consumer decision ([L06]). `CommitShaText` in presentational mode keeps its own cursor treatment (it is a copy target, not a link) exactly as today.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Resting underline on a confirmed Mention | appearance | CSS keyed off `data-tug-annotation` (already stamped by the annotator DOM pass) | [L06] |
| Which skin an atom wears | structure (decided by call site, statically) | props / component choice; no runtime state | [L06], [L19] |
| Detection gate | none — deletion of a per-surface flag; resolver stores unchanged | existing `useSyncExternalStore` / `VerdictBatcher` paths untouched | [L02] |

No new stores, no new React state, no new subscriptions.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/tug-atom-ref.tsx` | the read-only atom skin (renamed/widened `ToolFileRef`) |
| `tugdeck/src/components/tugways/tug-atom-ref.css` | its file-pair CSS, mono-pinned |
| `tuglaws/entity-presentation.md` | the doctrine (W6) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TugAtomRef` | component | `tug-atom-ref.tsx` | per Spec S02 |
| `ToolFileRef`, `tool-file-ref.tsx`/`.css` | delete | `components/tugways/blocks/` | replaced by `TugAtomRef` |
| `AnnotationContext.proseCitesPaths` | delete field | `lib/annotator/types.ts` | [P01] |
| `isUnambiguousInProse` | delete fn + tests | `lib/annotator/detect-path-reference.ts` | [P01] |
| `annotatePathsInText` | modify | `lib/annotator/annotate-content.ts` | drop the `licensed` check |
| `collectTextNodes` | modify | `lib/annotator/wrap-matches.ts` | drop `inCode` from the site record + recursion |
| `RefAtom` | modify | `components/gazette/gazette-card.tsx` | chip → `TugAtomRef` (annotate=false); label `Commit <8>` |
| `CommitShaText` | modify | `components/tugways/commit-sha-text.tsx` | renders the skin; keeps name, gestures, `content` prop |
| `gallery-entity-presentation.tsx`/`.css`, registration, `at0381` | delete | bench | #step-7 |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/entity-presentation.md` — the doctrine (see #step-6 for required content).
- [ ] `tuglaws/INDEX.md` — one row for the new doc.
- [ ] Module docstrings updated where behavior changed: `annotate-content.ts` (the license paragraph), `types.ts`, `tug-annotation.css` (resting-plain retired), `tug-markdown-view.css`, `tug-atom-ref.tsx`, `commit-sha-text.tsx`, `gazette-card.tsx` (`RefAtom`).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (`bun test` in `tugdeck/`) | detection gate deletion; label formatting | `annotator/__tests__/` updates in #step-1 |
| **App-test (selective)** | real-app assertions on marking, appearance, copy | `at0307`, `at0346`, `at0365`/`at0366`/`at0368`; run via `just app-test-changed` |
| **Probe (uncommitted)** | W1 cost before/after | restored `at0309` per [Q04] |
| **Build gate** | prod bundle integrity | `bunx vite build` per step |

New assertions belong with the surface they cover, not in a new file per work item (brief, Coverage).

#### What stays out of tests {#test-non-goals}

- No standing annotator-cost pin — deliberately deleted by the user; measurement is a one-off probe ([P05]).
- No jsdom/mock render tests — app-tests drive the real app; unit tests cover pure detection/formatting functions only.
- No pixel assertions on the underline color — `color-mix` on `currentColor` is theme-derived by construction; assert the `text-decoration-line`/`thickness` computed style instead (transitions can poison mid-flight color reads).

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Applies to every step.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | One detection gate (W1) | done | `820f5aebe` |
| #step-2 | Resting underline (W2/W3) | done | `fa1c52bd5` |
| #step-3 | `TugAtomRef` rename + widen | done | `1fe6935f1` |
| #step-4 | Gazette refs adopt the skin (W4) | done | `86af912cf` |
| #step-5 | Commit surfaces adopt the skin (W5) | done | `d8490c8ab` |
| #step-6 | Doctrine into tuglaws (W6) | done | `517986bdc` |
| #step-7 | Bench retirement | done | `2e7141c78` |
| #step-8 | Integration checkpoint | done | N/A (verification only) |

#### Step 1: One detection gate (W1) {#step-1}

**Commit:** `tugdeck(annotator): one detection gate — retire the inCode license and proseCitesPaths`

**References:** [P01] resolver-only gate, [P05] cost probe, [Q04], Risk R01, (#current-behavior-map, #w1-behavior-delta)

**Artifacts:**
- `annotate-content.ts`: `annotatePathsInText` sends every scanned reference to `resolvePath`; the `licensed` expression and its comment are gone; module docstring's license paragraph rewritten.
- `types.ts`: `proseCitesPaths` field deleted.
- `wrap-matches.ts`: `inCode` removed from the site record and `collectTextNodes` recursion.
- `detect-path-reference.ts`: `isUnambiguousInProse` deleted; `__tests__/detect-path-reference.test.ts` loses its describe block.
- `gazette-card.tsx`: `proseCitesPaths: true` line and its comment removed from `useGazetteAnnotation`.
- `gallery-entity-presentation.tsx`: patched minimally to compile without the field (its today/proposed *detection* split collapses; the underline split remains until #step-7 deletes it).
- `at0307-transcript-file-path-links.test.ts`: add an assertion that a bare, unbackticked relative filename in assistant prose marks once the resolver confirms it (the W1 behavior delta), alongside its existing bare-filename/index case.

**Tasks:**
- [ ] Before touching code: restore the probe (`git show bcf6c6a1f^:tests/app-test/at0309-annotator-cost.test.ts > tests/app-test/at0309-annotator-cost.test.ts`), run `just app-test tests/app-test/at0309-annotator-cost.test.ts`, record its report; if it cannot run against current APIs, capture `annotateCounters()` via `evalJS` on a populated Session card instead ([Q04]).
- [ ] Make the deletions above; `grep -rn "proseCitesPaths\|isUnambiguousInProse" tugdeck/src` must return nothing.
- [ ] Re-run the probe after; compare `passes` / `totalMs` / `textNodes`; record both readings in the commit message; delete the probe file (never commit it).

**Tests:**
- [ ] `cd tugdeck && bun test` — annotator unit tests green after the deletions.
- [ ] `just app-test-changed` — includes `at0307` (covers `tugdeck/src/lib/annotator/`) and `at0346`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed` — VERDICT green; new `at0307` assertion passes.
- [ ] Probe delta recorded; probe file absent from `git status`.

---

#### Step 2: Resting underline (W2/W3) {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(annotation-css): resting underline for confirmed mentions; resting-plain retired`

**References:** [P02] resting rule, Spec S01, Risk R02, brief [P04]/[P05], (#s01-underline-selectors, #current-behavior-map)

**Artifacts:**
- `styles/tug-annotation.css`: Spec S01 block for wrapped runs; "Resting-plain" doctrine comment replaced with a pointer to the (upcoming) tuglaws doc; hover rules unchanged.
- `tugdeck/src/components/tugways/tug-markdown-view.css`: Spec S01 block for annotated inline `<code>`; the "resting appearance is the ordinary inline-code chip" comments updated.

**Tasks:**
- [ ] Apply Spec S01 exactly — kinds enumerated, `session` excluded, no `code[…="commit-sha"]` selector, no color/tint change, no layout-affecting property; every new color-setting rule carries its `@tug-renders-on` comment ([L16]).
- [ ] Visual pass on the live app (HMR): Session card and Gazette, dark + light theme — six-mention density reads as a referenced document, not a link field.

**Tests:**
- [ ] Extend `at0346` with a computed-style assertion: a confirmed wrapped run and a confirmed inline-code path show `text-decoration-line: underline` at rest; an *unannotated* inline `<code>` span shows `none` (assert the un-animated property, not interpolated colors).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed` — VERDICT green.

---

#### Step 3: `TugAtomRef` rename + widen {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(tug-atom-ref): ToolFileRef becomes the read-only atom skin — renamed, mono-pinned, commit-capable`

**References:** [P03] TugAtomRef, [P04] commit label, [Q01], [Q02], Spec S02, brief [P06]/[P07]/[P09], (#s02-tug-atom-ref-api, #symbols)

**Artifacts:**
- New `tug-atom-ref.tsx` + `.css` per Spec S02; `blocks/tool-file-ref.tsx` + `.css` deleted.
- Call sites updated: `read-tool-block.tsx`, `write-tool-block.tsx`, `edit-tool-block.tsx`, `notebook-edit-tool-block.tsx`, `pulse-beat-text.tsx`, bench (compile-only patch). Tool headers keep byte-identical behavior (self-stamped annotation, findable, focus-refuse, full-path title); their cursor/hover affordance now arrives via the `data-tug-annotation` selector (Spec S02) instead of the retired `--link` class — same pixels, different key.
- `at0307` `@covers` path updated from `blocks/tool-file-ref.tsx` to `tug-atom-ref.tsx`.

**Tasks:**
- [ ] Implement Spec S02; keep `fileRefBasename` exported.
- [ ] `grep -rn "ToolFileRef\|tool-file-ref" tugdeck/src tests` returns nothing (docstrings included — no legacy vocabulary survives, per the brief's Vocabulary section).
- [ ] `just app-test-covers-check` passes.

**Tests:**
- [ ] `cd tugdeck && bun test`
- [ ] `just app-test-changed` — tool-header surfaces (`at0307` et al.) still green; headers visually unchanged (mono was already inherited there, so the font pin is a no-op in situ).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-covers-check && just app-test-changed` — VERDICT green.

---

#### Step 4: Gazette refs adopt the skin (W4) {#step-4}

**Depends on:** #step-3

**Commit:** `gazette(refs): trailing refs wear the read-only atom skin`

**References:** [P03], [P04], brief [P06]/[P08], call-site inventory rows W4, (#current-behavior-map)

**Artifacts:**
- `gazette-card.tsx` `RefAtom`: `TugAtomChip` replaced by `TugAtomRef` (`annotate` false — the existing `annotationProps` wrapper span keeps owning the contract and the pending/unresolvable tooltips); file/directory refs label by basename; commit ref becomes `entity: { kind: "commit" }` with the `Commit <8>` default label; `GAZETTE_CHIP_FONT_SIZE` and the `TugAtomChip` import removed. Session refs untouched (`TugSessionCitation`, brief [P08]). Link affordance needs no code here: Spec S02's `[data-tug-annotation] > .tug-atom-ref` rule lights up actionable refs through the wrapper and leaves pending/unresolvable ones inert.
- `gazette-card.css` `.gazette-post-refs`: sized for the skin — mirror the bench's settled row (`font-size: 0.9em` relative to the 13px post body, muted color, `--tug-space-md` gap); mono comes from the component ([Q01]).

**Tasks:**
- [ ] Swap the renderer; keep `unmentionedRefs` suppression and the `resolveGazetteRef` flow byte-identical.
- [ ] Visual pass against the bench's `RefsProposed` row while it still exists (deleted next-but-one step).

**Tests:**
- [ ] `just app-test-changed` — `at0365` (Gazette card), `at0366` (Gazette copy), `at0368` (session citations) green; update any `at0365`/`at0366` assertion that pinned the chip DOM or the `Commit: <8>` spelling.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed` — VERDICT green.

---

#### Step 5: Commit surfaces adopt the skin (W5) {#step-5}

**Depends on:** #step-3

**Commit:** `tugways(commit-atoms): receipt and History shas wear the read-only skin, labelled Commit <short>`

**References:** [P03], [P04], [Q03], brief [P07]/[P09], call-site inventory row W5, (#current-behavior-map)

**Artifacts:**
- `commit-sha-text.tsx`: renders `TugAtomRef` presentationally (GitCommit glyph + `Commit <8>` label) inside its existing gesture-owning element; the `content` prop decorates the sha characters within the label; copy text already `Commit <8>` — unchanged. Component name and module docstring updated to say what it now is.
- `session-commit-receipt-block.tsx`, `commit-presentation.tsx` (`CommitIdentity` → History rows via `tug-history-list.tsx`): consume the new rendering; layout adjusted so `Commit 227a8eb9 <subject>` reads correctly in a History row.
- `commit-sha-text.css` folded into / reconciled with `tug-atom-ref.css` usage (no second hand-rolled inline-code look survives — the brief's form 3 hand-roll retires).

**Tasks:**
- [ ] Swap the rendering; verify every pointer-gesture stop (`stopPropagation` suite) still guards the History row's expand toggle (right-click on a sha must not fold the row).
- [ ] [Q03] verification: select across the Gazette refs row and across a receipt header; plain copy and right-click copy yield the single spelling `Commit <8>`; a commit sha *written in prose* still copies as its bare characters (Mention fidelity).
- [ ] Visual pass: `/commit` receipt and History shade.

**Tests:**
- [ ] `just app-test-changed` — covers `commit-sha-text` / `commit-presentation` / `tug-history-list` consumers; extend the Gazette copy test (`at0366`) with the one-spelling assertion if not already pinned.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed` — VERDICT green.

---

#### Step 6: Doctrine into tuglaws (W6) {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `tuglaws(entity-presentation): placed atoms, written mentions — the presentation doctrine`

**References:** [P06] tuglaws doc, brief [P01]–[P09] and "Retired — do not re-propose", (#documentation-plan)

**Artifacts:**
- `tuglaws/entity-presentation.md`: the rule (placed vs written, with the arrived-as table), the vocabulary (atom / editable skin / read-only skin / mention — no third form), the two channels (code tone vs the rule), the labeling rule (an atom labels itself; a mention is labelled by its sentence), the resting-rule value (`1px solid color-mix(in srgb, currentColor 45%, transparent)` — no theme token, by design), the underline selector list as the registration point for future kinds, and the retired alternatives verbatim from the brief so they are not re-discovered as objections.
- `tuglaws/INDEX.md`: one row.
- CSS comment pointers from `tug-annotation.css` / `tug-markdown-view.css` to the doc (promised in #step-2).

**Tasks:**
- [ ] Write the doc; cross-link `dash/entity-presentation.md` as origin; no plan-step numbers or bug history in it — doctrine only.

**Tests:**
- [ ] None (prose).

**Checkpoint:**
- [ ] Doc renders clean; INDEX row present; `grep -rn "resting-plain" tugdeck/styles tugdeck/src` shows no surviving doctrine claims that contradict it.

---

#### Step 7: Bench retirement {#step-7}

**Depends on:** #step-6

**Commit:** `tugways(gallery): retire the entity-presentation bench — the app is the proposed column now`

**References:** brief "Bench" paragraph, (#strategy, #non-goals)

**Artifacts:**
- Deleted: `tugdeck/src/components/tugways/cards/gallery-entity-presentation.tsx`, `gallery-entity-presentation.css`, the registration block in `gallery-registrations.tsx` (the `TEMPORARY` entry with `componentId: "gallery-entity-presentation"`), and `tests/app-test/at0381-entity-presentation-bench.test.ts`.

**Tasks:**
- [ ] Delete all four; `grep -rn "gallery-entity-presentation\|gep-" tugdeck/src tests` returns nothing.
- [ ] `just app-test-covers-check` passes (no `@covers` now points at deleted files).

**Tests:**
- [ ] `cd tugdeck && bun test`

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-covers-check`

---

#### Step 8: Integration Checkpoint {#step-8}

**Depends on:** #step-1, #step-2, #step-4, #step-5, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria), brief "Done means"

**Tasks:**
- [ ] Walk the brief's seven "Done means" items against the built app and the diff; confirm `registry.ts` untouched for the whole phase (`git log --oneline -- tugdeck/src/lib/annotator/registry.ts` shows nothing new).

**Tests:**
- [ ] `just app-test-changed` over the phase's full working diff; if any harness-adjacent file was touched (it should not be), answer a CORE TIER ADVISED advisory with `just app-test`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build && bun test`
- [ ] `just app-test-changed` — VERDICT green.
- [ ] `grep -r "proseCitesPaths\|isUnambiguousInProse\|ToolFileRef" tugdeck/src` returns nothing.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Transcript entities painted by one rule — placed values as the read-only atom skin with self-carrying labels, written values as their own characters with a resolver-gated resting underline — with detection gated identically on every surface, no gesture changed, and the doctrine recorded in tuglaws.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] A resolving path is marked, and looks the same, backticked or bare or line-cited, on Session card and Gazette (at0307 + visual).
- [ ] An inline `<code>` span that resolves to nothing looks exactly as today (at0346 computed-style).
- [ ] `grep -r proseCitesPaths` returns nothing (step-8 grep).
- [ ] Every placed value in read-only ink wears the read-only skin; every commit atom says `Commit <8>` (steps 4–5 visual + copy assertions).
- [ ] No gesture changed; `registry.ts` untouched (step-8 git check).
- [ ] No meaningful annotator-cost regression on the Session card (step-1 probe readings, recorded in its commit message).
- [ ] Bench and `at0381` deleted (step-7).

**Acceptance tests:**
- [ ] `just app-test-changed` green over the phase diff.
- [ ] `cd tugdeck && bun test && bunx vite build` green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Promote the doctrine's decisions into global `[D##]` entries in `tuglaws/design-decisions.md` if they prove load-bearing beyond this surface.
- [ ] Widen `TugAtomRef` to further placed kinds (image atoms in read-only ink) if a surface asks for it.

| Checkpoint | Verification |
|------------|--------------|
| Build + unit | `cd tugdeck && bunx vite build && bun test` |
| App behavior | `just app-test-changed` |
| Coverage integrity | `just app-test-covers-check` |
| Vocabulary purge | step-8 grep set |
