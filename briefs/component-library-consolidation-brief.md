<!-- brief-skeleton v1 -->

# Audit, prune and consolidate the tugways component library

**Purpose:** The UI component library in `tugdeck/src/components/tugways/` has grown past what its authoring guide describes: it carries components nothing uses, repeats the same shapes in feature CSS, and has drifted in its prop vocabulary. The library should be a small, consistent, enforced surface again.

---

## Purpose {#purpose}

The request, 2026-11-11:

> I want to audit, consolidate, and generally improve the *UI component system* we use for Tug. Tasks I want done are:
> - List usage of all the components we have and call out the components that are not being used, listing them for possible elimination.
> - Find the component-like usages of UI elements that are not currently factored properly as re-usable components with established APIs.
> - For all components, I want to audit their APIs for consistency and correctness across the library.

The audit below was run the same day at `2a6eb3e10`. `components/tugways/` then held 368 top-level files, 106 of them `tug-*.tsx`, plus 278 files in `cards/`. The governing document is `tuglaws/component-authoring.md` ([L19]).

---

## Evidence {#evidence}

How each finding was established is stated on it. Findings [F01]–[F03] and [F12]–[F13] were counted by script and cross-checked by symbol search in this session. Findings [F04]–[F11] come from three read-only agent passes that read the files and cited lines; they were not re-checked line by line, so a step that acts on one confirms the cited site first.

### Usage

**[F01] Six files have no consumer in the app or the gallery.** `tug-toggle-button`, `tug-chart-glyph` (only a stale section in `theme-pairings.ts`, near line 2711, names its CSS), `body-kinds/katex-block` (math renders through `lib/markdown/enhance-math.ts`), `cards/session-jump-to-bottom-button` (a copy of `tug-jump-to-bottom-button` differing only in token prefix; both real consumers use the `tug-` one), `cards/session-notice-block` (one test, no consumer) and `cards/session-push-receipt-block` (one test, no consumer). Established by counting importers per module path across `tugdeck/src`, then searching each exported symbol for JSX or call uses. **(verified)**

**[F02] Eight components are consumed only by their own gallery card.** `tug-markdown-view.tsx`, `tug-split-pane` (comments in `cards/session-card.tsx` lines 13 and 5116 say it was replaced), `tug-skeleton`, `tug-marquee`, `tug-color-picker`, `tug-color-adjustment`, `tug-color-well` (its only non-gallery consumer is `tug-color-adjustment`), and `tug-textarea` (gallery plus `spikes/spike-focus-language.tsx`). `tug-markdown-view.css` is a different matter: `src/main.tsx` line 92 and `src/body/body-main.ts` line 34 import it globally and `tug-markdown-block.css` depends on its declarations. Together with [F01] these 14 TSX/CSS pairs are about 6,600 lines. **(verified)**

**[F03] Eleven public components have exactly one consumer.** `tug-find-cluster` (only `tug-find-bar`), `tug-activity-line` (only `tug-session-row`), `tug-status-cell`, `tug-placard`, `tug-report-panel`, `tug-control-bar`, `tug-tab-view`, `tug-cue`, `tug-clamp`, `tug-modal-input-dialog`, and `tug-context-menu` (only `cards/pdf-view.tsx`, while `tug-editor-context-menu` has ten consumers). **(verified)**

### Unfactored UI

**[F04] Raw HTML controls are rare; five lack the focus-refusal contract.** Feature code inside the library has 12 raw `<button>`s and code outside it has 3 (`chrome/update-pill.tsx` lines 198 and 211, `devtools/log-row.tsx` line 90); there are no raw inputs, textareas, selects or links. Five carry no `data-tug-focus="refuse"`: `chrome/session-error-block.tsx` lines 102 and 113, `chrome/session-thinking-block.tsx` line 327, `body-kinds/image-block.tsx` line 267, and `cards/session-card-telemetry-popovers.tsx` lines 334 and 868. Three dismiss-X buttons (`session-pending-context-strip`, `side-question-overlay`, `tug-attachment-preview`) are the same reset written three times. (agent read)

**[F05] The same rule blocks exist under different class names.** (agent read)

- Body-kind header strip: eight blocks (`file`, `diff`, `terminal`, `path-list`, `json-tree`, `todo-list`, `search-result`, `agent-transcript`) restate the same 12 declarations; none use `blocks/block-strip.tsx`.
- Settings group box with the legend on the border: copied comment for comment in `settings-general-body.css`, `settings-session-card-body.css`, `text-card-controls.css` and `card-view-controls.css`.
- Rail card shell: the Cards, Jots and Arcs cards repeat the root scroller, content column, drop-caret wrapper, toolbar (`.cards-toolbar` and `.jots-toolbar` are byte-identical) and empty line (four identical blocks; `overview-card.css` line 395 says so in a comment).
- Sheet header and notice: `hooks-sheet.css` and `skills-sheet.css` are identical; `memory-sheet`, `usage-sheet` and `data-visualization-sheet` repeat parts.
- Receipt header: the commit, push and join receipts share one header shape in three CSS files.
- Repo notices: `tug-no-git-notice.css` and `tug-non-repo-notice.css` differ by one rule, and both imitate `TugStepRow`.

**[F06] The same hook skeleton is written with different payloads.** Three identity menus (`commit-identity-menu.tsx`, `file-identity-menu.tsx`, `session-identity-menu.tsx`) and three row menus (`useSpaceRowMenu`, `useJotRowMenu`, `useArcRowMenu`) hand-roll point-menu state around `TugEditorContextMenu`. Three tip-portal hooks (`file-tip-portals.tsx`, `commit-tip-portals.tsx`, `session-citation-portals.tsx`) each carry a private `sameMounts`. Three arc notice controllers repeat subscribe, sequence gate, post. (agent read)

**[F07] Feature CSS reaches into primitives where a variant is missing.** `TugListView` and `TugListRow` take the most: about 20 selectors in `cards/cards-card.css`, 14 in `cards/session-card.css`, and a `height: auto` override on `.tug-list-view` in eight places (three rail cards, four sheets, `sheet-option-list.css`). `TugTranscriptEntry` is restyled nine times in `overview-card.css`. `TugInlineAlert` is rewritten in `session-usage-limit-notice.css`, `TugBadge` in `cards-card.css` line 552, `TugColumnBadge` through six token overrides in `cards-column-badge.css`, and button minimum widths or icon sizes in six files. `.tug-tab:focus { outline: none }` is duplicated in `help-sheet.css` and `permission-rules-editor.css`. (agent read)

**[F08] Several small primitives are missing and several existing ones are not adopted.** Missing: a controlled disclosure toggle (five hand-rolled chevrons), a key/value row (`UsageStat`, `TelemetryRow` and three popover legends), an empty-state line, a removable chip, and a named-icon lookup (`icons[name as keyof typeof icons]` in ten places). Not adopted: `BlockCopyButton` (three hand-wired copy flashes in devtools), `TugSectionLabel` (four uppercase sheet titles), `TugBadge` (`session-caution-badge`, the devtools level chip), `CommitShaText` (`base-motion-receipt-block.tsx` line 41). (agent read)

### API

**[F09] The prop vocabulary has drifted.** (agent read)

- Semantic colour: `role` in 11 components, `tone` in 6, and `tug-icon-button.tsx` line 53 maps `tone` onto `role`. Also `fillRole`, `confirmRole`, `iconRole`, `busyRole`, `onColorRole`, `iconColor`. `variant` means severity in the banners and layout in accordion, box, list row and tooltip.
- Size: six scales and three defaults. Most default to `md`; badge, icon button, slot, combo box, file chooser and filter field default to `sm`. The `sm|md|lg` union is declared ten times.
- Icon: a `ReactNode` in 11 components and a string name in 5 (alert, both banners, inline alert, sheet).
- Chain dispatch: `action` + `target` (button, cue), `dispatch: ActionEvent` (icon button), `senderId` form slots; in `tug-popup-list.tsx` line 346 `action` is a `ReactNode`.
- Smaller drift: `ariaLabel` in `tug-dialog-button.tsx` against `"aria-label"` elsewhere; `open` against `visible`; `subtitle` against `description`; five density vocabularies; four ways to override `data-slot`.

**[F10] Many components break the authoring guide's structural rules, including its named references.** A pattern-match pass over 117 files counted about 45 with no `forwardRef`, about 70 with no `...rest` on the root, about 75 with a closed props interface, 19 with a missing or mismatched `data-slot`, and 54 whose docstring does not cite [L19]; the counts are heuristic. The agent read confirmed the pattern and the specific cases: `tug-checkbox.tsx` and `tug-switch.tsx`, which the guide names as reference implementations, have closed interfaces and put `className` on a different element depending on whether a label is present; `tug-combo-box.tsx` and `tug-file-chooser.tsx` forward the ref to the input, not the root; `tug-copy-badge.tsx` puts the caller's `className` on a child; appearance is held in `useState` in `tug-label.tsx` line 219, `tug-textarea.tsx` line 213, `tug-combo-box.tsx` lines 227–228 and `tug-clamp.tsx` line 82. The best conformers are `tug-separator`, `tug-badge`, `tug-label`, `tug-input`, `tug-choice-group` and `tug-list-row`. (script count verified; cases by agent read)

**[F11] Callback props for user actions remain, against [L11], and near-twin components duplicate props.** Callbacks in primitives: `tug-toggle-button` (`onPressedChange`), `tug-dialog-button` (`onClick`), `tug-jump-to-bottom-button` (`onClick`), `tug-slot` (`onSelect`), `tug-slot-layout` (`onSelectSlot`), `tug-inline-dialog` (`onSelectOption`), `tug-placard` (`onClose`), `tug-find-bar` (`onClose`), `tug-combo-box` and `tug-file-chooser` (`onChange`, `onSubmit`, `onSettle`). Callbacks in feature components: `tug-changes-list.tsx` (nine), `tug-text-card-editor`, `tug-prompt-entry`. Near-twins: banner and pane banner; arc gauge and linear gauge; combo box and file chooser (about 18 shared props); sheet content and sheet panel (11 duplicated props); badge and copy badge (`TugBadge` already has `copyText`). (agent read)

### Around the library

**[F12] Nothing enforces the authoring guide.** `tugdeck/package.json` has audits for tokens, motion, visibility, type alignment, contrast and gamut, and the `justfile` has no recipe that checks component shape. `card-taxonomy.test.ts` guards where gallery, spike and fixture cards are registered, and nothing else guards the component surface. **(verified)**

**[F13] The gallery and the public surface do not match.** 48 public `tug-*` components have no gallery card, while six gallery cards document components nothing else uses ([F02]). **(verified)**

**[F14] App features sit in the public surface, and the prefix is not a reliable signal.** Top-level `tug-*` files that import stores and are not primitives: `tug-logout`, `tug-quit-guard`, `tug-version-gate`, `tug-restore-gate`, `tug-no-git-notice`, `tug-non-repo-notice`, `tug-prompt-entry` (17 store imports), `tug-changes-list`, `tug-history-list`, `tug-diff-document`, `tug-report-panel`, `tug-dictation-button`, `tug-session-identity`, `tug-status-cell` (its classes are all `session-telemetry-*`). In the other direction `cards/tug-attachment-preview` and `cards/tug-atom-{markdown,text}-body` wear the prefix in feature code, and feature code imports `internal/tug-button` directly from `chrome/card-title-bar.tsx` (eight sites), `devtools/log-inspector.tsx`, `card-slot-badge.tsx` and `session-masthead.tsx`. (agent read)

**[F15] The authoring guide carries history its own rules forbid.** `tuglaws/component-authoring.md` is 1,627 lines and includes a retired experiment (the document-shrink-clamp section), "Phase E.3" and "A2.x" references, and commit hashes, while its docstring rule bans history and plan references. **(verified)**

---

## Decisions {#decisions}

**[B01] Delete everything with no consumer.** The six files of [F01] go, with their CSS, their tests, and the stale `tug-chart-glyph.css` section in `theme-pairings.ts`. Unused code in a library is read as endorsed, and each of these has a live replacement or no purpose.

**[B02] Delete the gallery-only components, except the textarea.** `tug-skeleton`, `tug-marquee`, `tug-split-pane`, `tug-markdown-view.tsx`, and the whole colour cluster (`tug-color-picker`, `tug-color-adjustment`, `tug-color-well`) go, with their gallery cards and registrations. The user's call on the colour cluster: the theme editor is probably never coming back. `tug-markdown-view.css` stays, because it is loaded globally and `tug-markdown-block.css` builds on it; renaming it to match its real owner is in scope. `tug-textarea` stays, because a multi-line field is a plausible need and the primitive is sound.

**[B03] `role` names semantic colour on controls that carry emphasis; `tone` names it on passive status surfaces; every other spelling is removed.** Approved by the user. This rules out `fillRole`, `confirmRole`, `iconRole`, `busyRole`, `onColorRole` and `iconColor` as prop names, the `tone`-to-`role` translation inside `tug-icon-button.tsx`, and `variant` as a word for severity. One name everywhere was the alternative; two names were kept because the two families take different value sets and renaming all of one would touch more call sites for no gain in meaning.

**[B04] Callback props become chain actions in primitives only.** Approved by the user. The primitives listed in [F11] move to `useControlDispatch` or `useResponderForm` per [L11]. Feature components keep their callbacks for now; converting `tug-changes-list.tsx`'s nine is a redesign, not a rename.

**[B05] The library has three tiers, and the directory says which is which.** Primitives at the top level of `components/tugways/` import no store. Building blocks live in `internal/` and are imported only by primitives. Feature components live outside the top level, without the `tug-` prefix. The single-consumer components of [F03] move to `internal/` or beside their one consumer; the store-bound files of [F14] move out; feature code stops importing `internal/tug-button`. This is the guide's existing public/internal rule applied, plus one new line: a primitive that imports a store is a feature.

**[B06] One vocabulary, written down once and typed once.** Beyond [B03]: one size scale with a documented default, one density vocabulary, `icon` as a `ReactNode`, `open`/`onOpenChange` for presence, `"aria-label"` as the accessible-name prop, one chain-dispatch prop shape, one way to override `data-slot`. The unions live in a single shared types module and components import them. The vocabulary goes into `component-authoring.md` as a table. The specific winners are chosen in the arc from the usage counts in [F09], the most-used spelling winning unless it is ambiguous.

**[B07] Every primitive conforms to the guide, and a lint holds it there.** Conformance is fixed starting with `tug-checkbox.tsx` and `tug-switch.tsx`, because the guide points readers at them, then the worst cases of [F10], then the rest. A conformance check (exported props interface extending native props, `forwardRef` on a DOM root, `data-slot` matching the file name, `className` through `cn()`, `...rest` on the root, the [L19] citation) runs in `just lint` with a ratchet: an allowlist of today's violators that may only shrink.

**[B08] Missing variants are added to the primitive, and the reach-in CSS is deleted in the same change.** `TugListView` and `TugListRow` go first ([F07]): a content-fit sizing, a rail presentation, a struck or dimmed row state, a title slot. Then `TugTranscriptEntry` density, `TugInlineAlert` accent, `TugBadge` bare numeric, `TugColumnBadge` tone, and a button minimum-width or icon-size prop. A variant that lands without removing the selectors it replaces has only added code.

**[B09] Repeated shapes are extracted where the copies are identical, and adopted where a primitive already exists.** Extract: the body-kind header strip, the settings group, the rail card shell with its toolbar and empty line, the sheet header and notice, the receipt header, one point-menu hook, one span-portal hook, and the small primitives of [F08]. Adopt: the existing primitives named in [F08], and `TugPushButton`/`TugIconButton` for the raw buttons of [F04]. The two repo notices become one component or a `TugStepRow` variant.

**[B10] Near-twins share a base.** Banner and pane banner, the two gauges, combo box and file chooser, sheet content and sheet panel each share their common props through one type and one implementation path. `TugCopyBadge` folds into `TugBadge`'s existing `copyText`.

**[B11] Every surviving primitive has a gallery card, and the guide is trimmed to rules.** The gallery gap of [F13] closes after the prune and the moves, so cards are written once against the final API. `component-authoring.md` loses its history ([F15]) and gains the vocabulary table of [B06] and the tier rule of [B05].

---

## Open Questions {#open-questions}

- **Where do feature components moved out of the top level go?** [B05] says out; it does not name the directory. `cards/` already holds 278 files, so the candidates are the existing feature directories beside their consumers or a new sibling of `cards/`. Settled by looking at each file's consumers during the move.
- **Do the arc notice controllers fold into `transient-notice.ts` or get their own hook?** [F06] notes a pure model already exists there. Settled by reading whether its reconcile model fits a sequence-gated bulletin.

---

## Non-goals {#non-goals}

- **Converting feature components' callbacks to chain actions.** Deferred by [B04]; `tug-changes-list.tsx`, `tug-text-card-editor` and `tug-prompt-entry` keep theirs.
- **A single name for semantic colour.** Considered and rejected in [B03].
- **Keeping the colour picker cluster for a future theme editor.** Rejected in [B02]; themes are hand-authored CSS.
- **Visual redesign.** Extraction and variants reproduce today's appearance. A change a user can see is a defect in this work, not a result of it.
- **Rewriting component token contracts.** The guide's scope boundary stands: tokens and pairings change only where a merged or extracted component requires it.
- **Unit tests for every primitive.** Coverage is worth its own look; this work adds tests only for behaviour it changes.

---

## Exit {#exit}

An arc. The order matters because each stage shrinks or settles what the next one touches:

1. Prune: [B01] and [B02].
2. Draw the boundary: the moves of [B05].
3. Settle the vocabulary and write it into the guide and the shared types module: [B03], [B06].
4. Conform the primitives under the ratcheting lint, exemplars first, with the primitive-only [L11] conversion: [B07], [B04].
5. Add the missing variants and delete the reach-in CSS, list view and list row first: [B08].
6. Extract and adopt the repeated shapes, and merge the near-twins: [B09], [B10].
7. Close the gallery gap and trim the guide: [B11].

Stages 3 and 4 touch the most call sites. Stages 1, 2 and 7 are mechanical. Each stage is independently landable, so the arc may reasonably be cut into more than one.
