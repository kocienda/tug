# Tooltips — one mechanism, one shape per entity, colors that follow the theme

Hover a commit sha in the transcript and you get a rich gray card: subject, author · date, full sha, stat line, file roster. Hover the same commit's row in the History shade and you get its subject echoed back. Hover its date cell and you get a locale-spelled date; hover its receipt in a `/commit` block and you get the word "modified"; hover the diff document header and you get nothing. Five hover answers for one entity — and every one of them is the OS-native `title=` attribute, which is why they are all a light gray box with the system font in the middle of a dark theme.

The finding that shapes this whole brief: **there are no hand-rolled hover popups in tugdeck.** Every shaggy tooltip is native `title=` (~110 true tooltip sites across ~25 files), and the app already owns exactly one good mechanism it is mostly not using. `TugTooltip` is tokenized, animated per [L13]/[L14], portaled to the canvas overlay, chain-dismissed via `observeDispatch`, and has `truncated`/`suppressOpen` open-gating. `TugActionTooltip` layers the keyboard-chord chip on top and reads the chord from the keymap registry, re-rendering on rebind. The work is convergence, not invention.

## The mechanisms in play

| Mechanism | Sites | Look |
|---|---|---|
| `TugTooltip` (`tugways/tug-tooltip.tsx`) | ~32 non-gallery | themed bubble, arrow, 500ms delay |
| `TugActionTooltip` (`tugways/tug-action-tooltip.tsx`) | 12 | same bubble + registry-read chord chip |
| Native `title=` — direct, via `TugIconButton`/`TugOptionGroup`/`TugStatusCell` passthrough props, or stamped imperatively by the annotator (`wrap-matches.ts:147`) | ~110 | OS chrome: unthemed, wrong delay, no chip, no dark mode |

The one *documented* reason native `title` exists is `lib/annotator/commit-summary.ts:18–22`: annotator marks are stamped imperatively onto DOM the annotator walks, so there is no React element to hang a component on. Every other native site is drift.

## Where the entities diverge today

**Commit — five contracts, none componentized.** Inline shas and Gazette ref chips get `commitSummary()` (`lib/annotator/commit-summary.ts:74`) as a native title. History rows get `title={subject}` (`commit-presentation.tsx:177`). The date cell gets `formatCommitStamp(iso, "full")` (`commit-presentation.tsx:97`). The `/commit` receipt gets `title={f.status}` per file (`commit-block.tsx:282`). The diff document header gets nothing. Meanwhile the "N files changed, +A −R" string is spelled independently four times (`commit-summary.ts:54`, `commit-block.tsx:250–268`, `lib/git-diff-store.ts:141`, `commitCopyText` at `commit-presentation.tsx:263`).

**Session — one model citizen, then drift.** `identityTooltip()` (`tug-session-identity.tsx:225`) is the right thing: identity line, description, fork lineage, mono citation, in a real `TugTooltip`. But session rows show description-only with different side/align/arrow (`tug-session-row.tsx:449`), and the picker/session-card family hovers raw project paths via native `title`.

**File — the same job done two ways.** ~15 sites do full-path-on-hover with `title={path}` (`tug-changes-list.tsx:245,256`, `tool-file-ref.tsx:121`, `file-block.tsx:917`, `diff-block.tsx:1076,1183`, `open-quickly-overlay.tsx:252`, …) while the componentized version of exactly that idea already ships in `middle-ellipsis-path.tsx:89` and the tool-block header family (`TugTooltip truncated`). Which one a surface got is an accident of authorship date.

**Action — four tiers of fidelity.** 12 sites use `TugActionTooltip` correctly; 5 pass a hand-derived `shortcut` (`tug-prompt-entry.tsx:3461,3485,3611`, `tug-choice-group.tsx:519`); 9 use `TugTooltip` with no chip where a chord exists (pane bullseye/overflow/width, masthead); and ~30 buttons carry bare native `title` — many by construction, because `TugIconButton:294`, `TugOptionGroup:352`, and `TugStatusCell:185` forward a `title` prop straight to the DOM.

**Hygiene.** `--tugx-tooltip-bg/-fg/-border` are declared on `body` in two stylesheets (`tug-tooltip.css:20–28` and `tug-menu.css:80–82`); load order decides. Two date-formatting stacks exist: Intl-based `useTimeFormats` (Gazette) and hand-built `formatCommitStamp` (commits).

## Decisions

**[T01] Tooltips follow the theme — and the ones that don't are not tooltips we own.** Dark themes get dark tooltips, light themes light ones. `TugTooltip` **already does this** and needs no retheme: the bubble sits on the `screen` surface tier, which is `--tug-color(indigo, l: 330, c: 40)` in brio against `l: 930` default text (dark bubble, light text) and `l: 940` in harmony against `l: 150` text (light bubble, dark text). The doctrine line in `theme-engine.md:52–53` — "`screen` is the lone exception in light themes" — means screen stays *light in light themes* rather than becoming a dark recessed well like `sunken`; it does not mean light everywhere. `token-naming.md:173`'s phrase "the always-light tier" is the misleading one, and it gets reworded to say what the values do.

So every unthemed tooltip in the app is unthemed because it is **native OS chrome, not a `TugTooltip`**. The theming fix is not a token change; it is [T02] and [T05] — migrating the ~110 native sites onto the component. Nothing else in this brief needs to move for the colors to come right, and no theme file is touched. `screen` also stays the tooltip's tier rather than folding into `overlay`: the one-rung separation from menus/popovers (330 vs 310 in brio) is a deliberate read — an explanatory surface sits a step off an interactive one. Gate: `bun run audit:theme-contrast` stays inside the brio budget, and the gallery (`cards/gallery-tooltip.tsx`) gets a look in all six themes once migration lands, since surfaces newly arriving in the bubble (mono citations, stat rosters, status marks) must hold contrast on `screen` in every theme.

**[T02] `TugTooltip` is the only tooltip mechanism; native `title=` retires.** No law today sanctions native `title` — it grew in the gaps. After this brief, a hover explanation is a `TugTooltip` or it does not exist. Enforced the way `no_ad_hoc_ledger_opens` enforces ledger opens: a source-scanning test that fails on a DOM `title=`/`el.title =` outside a named allowlist, so the class of drift cannot regrow.

**[T03] One tip per entity.** Each entity gets a single content builder returning React nodes for `TugTooltip content=`, so every surface that hovers that entity shows the same fields in the same order:

- `commitTip(facts)` — subject; author · date; short sha (mono); stat line; file roster ≤8 with A/M/D/R marks and +/− counts (mono, tabular numerals); "… and N more". The `commitSummary` shape, promoted from OS chrome to canon. It replaces the subject-echo on History rows, joins the receipt block's hash badge, and covers the diff document header. The full-date hover on `CommitStamp` folds into it.
- `sessionTip(…)` — `identityTooltip()` extracted and shared: identity line, description, lineage, mono citation. Session rows keep `truncated` gating but show this body; one side/align/arrow policy across all session hovers.
- `fileTip(path, status?)` — full path in mono, `old → new` for renames, status word when known. All bare `title={path}` sites migrate onto `TugTooltip truncated` with this.

**[T04] Commit formatting consolidates into one module.** `lib/commit-format.ts` owns status marks, the stat line, the file roster, and the copy text. `commitSummary`, `commitCopyText`, the receipt block's badges, and the diff header all call it. Four spellings become one.

**[T05] A delegated hover layer replaces the annotator's native titles.** One listener on the transcript/Gazette container: when the pointer rests on an element carrying the annotation dataset (`data-tug-annotation`), a single shared `TugTooltip` mounts in the canvas overlay anchored to it, rendering the entity tip from the payload — which already carries the facts (`annotation-element.ts`, `payloads.ts`). Same 500ms delay, same `observeDispatch` dismissal as the component path. This removes the only structural reason native `title` existed and converts the most visible tooltip in the app in one move. `wrap-matches.ts` and `gazette-card.tsx` stop stamping `title`; `commitSummary`'s plain-text form survives only as `commit-format` copy text.

**[T06] Action tooltips: registry or nothing.** `TugActionTooltip` is the only way to pair a label with a chord. The manual-`shortcut` sites migrate; the prompt entry's submit chord keeps its hand-derived `⇧⏎`/`⏎` (a CM6 setting, not a registry command) but renders through the same chip. The `title` passthroughs on `TugIconButton`, `TugOptionGroup`, and `TugStatusCell` are replaced by `tooltip` + optional `action` props that render the component internally — the `TugChoiceGroup` item shape (`tug-choice-group.tsx:106–113`) is the precedent — which converts ~30 bare-title buttons by changing three components rather than thirty call sites. The 9 chip-less tooltips on chorded actions move up to `TugActionTooltip`.

**[T07] Truncation reveals standardize on `TugTooltip truncated`.** The scattered overflow-reveal `title=`s (sheets, settings keymap, lens rows, permission rules, Open Quickly) adopt the open-edge-gated pattern the tool-block headers already use — the tooltip appears only when the text is actually clipped.

**[T08] One token block, one clock.** The duplicate `--tugx-tooltip-*` declaration in `tug-menu.css:80–82` is deleted; `tug-tooltip.css` owns the aliases. Date formatting converges on one module serving both the Gazette's Intl formats and the commit stamp grains, so the same instant never renders two dialects.

**[T09] A chord chip must be true, in a menu as much as in a tooltip.** The reason an action tooltip is worth having is that it teaches a key that works. The same chip in a context menu makes the same promise, and three sites were breaking it on entities the reader had merely pointed at:

- `session-identity-menu.tsx` advertised `Copy as Atom ⌘C` while dispatching `COPY_SESSION_ATOM`. The chord was borrowed from a *different* command — `commandShortcut(TUG_ACTIONS.COPY)` — which is the one thing `commandShortcut` exists to prevent ([P11]), and the only cross-action borrow in the codebase. It was borrowed because `COPY_SESSION_ATOM` sits in `ACTIONS_OUTSIDE_THE_TABLE` and has no binding of its own to render. An action with no chord shows no chip.
- The same hook *claimed* the generic `COPY` verb (`[TUG_ACTIONS.COPY]: copyAtom`) for any session row or chip that had been clicked, with no selection required. `COPY` is `routing: "native"` — AppKit sends `copy:` to WebKit, and the JS chord pipeline bails before the chain — so the claim could never run `copyAtom`. What it did do is light up **Edit ▸ Copy** in the menu bar over a chip (`host-menu-state.ts` reads `chain.validateAction(COPY)`), where pressing it copies nothing.
- `use-copyable-text.tsx` put `⌘C` on Copy, plus decorative `⌘X`/`⌘V`/`⌘A` on three permanently-disabled rows — inherited by every `TugLabel`, `TugBadge`, and `CommitShaText`. This text is `user-select: none` by design, so the chord it advertised cannot reach it.

All three chip sets are removed and the `COPY` hijack with them; the menu items themselves are untouched, so `Copy as Atom` still writes the atom. The annotator's own entity menus (`lib/annotator/registry.ts`) were already correct — they carry `action` + `label` and nothing else — and are the model.

**[T10] Only a surface whose content can BE the document selection may register a natively-routed verb.** The chip was the symptom; the enablement lie underneath it was the loophole, and it is a trap two true facts set for each other. Cut/Copy/Paste/Delete/Select All are `routing: "native"` — the chord pipeline returns before the chain and AppKit performs them as `NSText` selectors against the document selection, so a responder's handler for them can never be reached. Meanwhile `computeEditCapabilities` asks `chain.validateAction(COPY)`, and `findValidationResponder` stops at the **first node holding a handler**, answering its `validateAction` or defaulting to **true**. So registering one of these verbs buys nothing and costs the truth of the Edit menu: the walk halts at a chip that cannot serve the verb, instead of reaching the text surface behind it that would have validated against a real selection.

`validateAction: () => false` is the wrong repair — it still halts the walk, so it would disable Copy even when an ancestor legitimately could serve it. Standing aside is the repair. Three responders now do:

- `use-copyable-text.tsx` registers **`COPY_COPYABLE`**, a new menu-only verb in `ACTIONS_OUTSIDE_THE_TABLE`. Its text is `user-select: none` and can never be the selection, so it had nothing to answer for; the right-click Copy is unchanged because a context menu authors its own `disabled` and dispatch never consults `validateAction`.
- `terminal-block.tsx` and `tug-attachment-preview.tsx` kept their responder nodes (both need the identity — one for collapse, one for the sheet's trapped focus) and dropped the `COPY` handler, which was unreachable dead code in both. Copying is their visible `BlockCopyButton` / Copy button, which works. Both carried comments asserting that ⌘C "is matched in the capture-phase keybinding pipeline and dispatched as the COPY action"; that was never true under native routing, and the comments now say what happens.

The guard is `__tests__/native-verb-claims.test.ts`: it reads the natively-routed set **from the registry** (so routing a new verb natively puts it under the guard automatically), scans every module for the registration shape, and holds the result to a six-file allowlist of real selection surfaces — with the reverse check too, since a stale allowlist entry quietly reopens the hole. Verified by reintroducing the violation: the test fails and names the file.

## Work

W1–W5 have landed; W6–W8 are open. What shipped:

- `lib/commit-format.ts` — the shared vocabulary (status marks, ± counts, pluralized count, totals, stat line, capped roster), with `lib/__tests__/commit-format.test.ts` carrying the cases the retired `commitSummary` suite proved. All five spellings now call it, including `diffSummaryLine`, whose header gained the comma the hover always had.
- `components/tugways/entity-tips.tsx` + `.css` — `commitTip` / `sessionTip` / `fileTip` over one skeleton (title, meta, mono, shape, roster, "… and N more"), with the roster's status marks taking the diff document's own tones.
- `TugTooltip` gained `variant="entity"`: a block flow at a 27rem cap, because a file roster in the 300px label cap wraps every path.
- `components/tugways/commit-tip-portals.tsx` + `annotation-portals.tsx` — the annotator's marks get real tooltips, portaled the way `useSessionCitationPortals` already portals citation chips. `commitSummary` and its `title` stamping are deleted: `TextRunMatch.title` is gone from the contract, so the mechanism cannot come back through that door.
- History rows show the commit tip instead of echoing their own subject; Gazette commit chips show it instead of an OS box; `CommitIdentityLine` takes the attribution that feeds it.
- `@covers` gaps closed: at0404 did not claim `tug-tooltip.tsx`/`.css` at all, so a change to the component pulled no test. at0404's overflow-menu assertion was also stale — `75e6a2442` renamed the label to "Assorted commands" and left the test behind.

| # | Change | Files |
|---|---|---|
| W1 | [T01]+[T08] hygiene: delete the duplicate token block, reword the "always-light tier" line. No retheme — the tiers are already correct | `tug-menu.css`, `tuglaws/token-naming.md` |
| W2 | [T04] `lib/commit-format.ts`; fold the four stat/roster spellings | `lib/annotator/commit-summary.ts`, `commit-presentation.tsx`, `body-kinds/commit-block.tsx`, `lib/git-diff-store.ts` |
| W3 | [T03] `commitTip` / `sessionTip` / `fileTip` builders | new `lib/entity-tips.tsx`, `tug-session-identity.tsx` (extract) |
| W4 | [T05] delegated annotator hover layer; stop stamping `title` | new hover controller, `lib/annotator/wrap-matches.ts`, `annotate-content.ts`, `lib/gazette-ref-resolve.ts`, `gazette-card.tsx` |
| W5 | commit surfaces adopt `commitTip` | `tug-history-list.tsx`, `commit-presentation.tsx`, `body-kinds/commit-block.tsx`, `tug-diff-document.tsx` |
| W6 | session + file surfaces adopt their tips | `tug-session-row.tsx`, `cards/session-card.tsx`, `session-picker-cells.tsx`, `tug-changes-list.tsx`, `tool-file-ref.tsx`, `file-block.tsx`, `diff-block.tsx`, `open-quickly-overlay.tsx` |
| W7 | [T06] `tooltip`/`action` props on the three passthrough components; migrate bare-title buttons; chip upgrades | `tug-icon-button.tsx`, `tug-option-group.tsx`, `tug-status-cell.tsx`, `chrome/tug-pane.tsx`, `session-masthead.tsx`, `jots-card.tsx`, telemetry popovers, side-question overlay, … |
| W8 | [T02]+[T07] guard test + remaining truncation-reveal migrations; tuglaws entry | new scan test, `tuglaws/component-authoring.md`, sheets/settings/lens call sites |
| W9 | [T09] chord chips off entity menus; drop the `COPY` hijack — **landed** | `session-identity-menu.tsx`, `use-copyable-text.tsx` |
| W10 | [T10] close the enablement loophole: `COPY_COPYABLE`, drop the unreachable `COPY` handlers, registry-derived guard test — **landed** | `action-vocabulary.ts`, `command-registry.ts`, `use-copyable-text.tsx`, `terminal-block.tsx`, `tug-attachment-preview.tsx`, `__tests__/native-verb-claims.test.ts` |

W1 was independent bookkeeping. W2–W5 were the commit spine and the highest-visibility win — and the whole *color* story, since a migrated tooltip is a themed tooltip by construction: the screenshot's gray OS box is now a themed card that tracks brio/nocturne/bravura dark and harmony/aria/vivace light. W6–W8 are breadth, and the honest reason they are the long pole: the remaining native `title=` sites are ~30 buttons, ~15 path reveals, and a scattering of overflow reveals, most reachable through the three passthrough props rather than one at a time.

One thing W5 left on the floor, in the `/commit` receipt (`body-kinds/commit-block.tsx`): the per-file `title={f.status}` hover, which wants `fileTip`. Its sibling defect is fixed — `tugx-commit-stat-num--add` / `--del` were rendered with no rule behind them, leaving the receipt's ± counts in body ink; they now take the same add/remove tones as the status chip beside them. `commit-block.css` carries no `@covers` from any app-test, which is why nothing caught it.

Remaining native `title=` after the commit spine: ~89 JSX sites across ~52 files (a majority are content props on `TugListRow`/`TugSheet`/`FieldSection` rather than tooltips), plus one imperative stamp left — `lib/tug-atom-img.ts:800`, the CM6 atom `<img>`. The annotator's stamping is gone.

Coverage: `at0404-title-bar-tooltips` (bubble + chip + rebind), the gallery surface (`cards/gallery-tooltip.tsx`) for visual review across themes, `bun run audit:theme-contrast` once new content kinds land in the bubble, and the W8 scan test as the permanent backstop. The annotator hover layer (W4) wants a new app-test alongside `at0346`/`at0310`, which already exercise the marks it will read.

## Relationship to `entity-presentation.md`

That brief governs how an entity is painted *inline* (Token / Ref / Mention); this one governs what hovering it *says*. They meet at the annotator: [P05]'s hover affordance on a Mention and this brief's [T05] hover layer are the same pointer-rest moment, and [P07]'s retirement of `CommitShaText` lands on surfaces W5 touches. Whichever brief executes second inherits the other's marks unchanged — the annotation dataset is the shared contract.
