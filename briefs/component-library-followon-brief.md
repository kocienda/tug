<!-- brief-skeleton v1 -->

# Give every primitive one root order, close the token-law gaps, and make the guide match the code

**Purpose:** The audit of the component-library consolidation (`65742885b`) left five should-fix items after the must-fix ones landed in `f7c874965`. Half the library's primitives ignore a caller's `data-slot`, a dozen let a caller's handler silently replace behaviour the control needs, the new CSS breaks three token laws, the authoring guide shows code that no longer exists, and Home does less than End in the Overview.

---

## Purpose {#purpose}

The audit's verdict on the consolidation was that fixups were needed and none was structural. The user split them in two:

> brief the must-fix items. we'll handle the should-fix as a follow-on arc as you suggest.

This is the follow-on. The five items as the user restated them:

> - **Half the primitives defeat the guide's `data-slot` override.**
> - **Caller handlers silently replace required behaviour.**
> - **Token-law gaps in the new CSS** ([L17], [L20], [L16]).
> - **The guide contradicts the code.**
> - **End and Home are now asymmetric in the Overview.**

None of these is a visible defect today. Each is a place where the library says one thing and does another, which is what the consolidation existed to end.

---

## Evidence {#evidence}

All readings were taken on `main` at `f7c874965` on 2026-11-12. Paths are under `tugdeck/src/components/tugways/` unless they say otherwise.

**[F01] 35 root elements write their literal `data-slot` after `{...rest}`, and 50 write it before.** The guide's vocabulary table (`tuglaws/component-authoring.md:198`) names `"data-slot"` through `...rest` as the override, which only works when the literal comes first. The 35 sites are in 33 files: `internal/tug-popup-menu`, `tug-alert`, `tug-arc-track`, `tug-atom-ref`, `tug-banner` (two), `tug-code-view`, `tug-combo-box`, `tug-commit-atom`, `tug-confirm-popover`, `tug-dialog-button`, `tug-editor-context-menu`, `tug-file-chooser`, `tug-filter-field`, `tug-find-bar`, `tug-icon-button`, `tug-inline-alert`, `tug-inline-dialog`, `tug-jump-to-bottom-button`, `tug-list-view`, `tug-markdown-block`, `tug-markdown-text`, `tug-message-editor`, `tug-meta-run`, `tug-pane-banner` (two), `tug-popup-button`, `tug-sheet`, `tug-sparkline`, `tug-sprite-icon`, `tug-status-mark`, `tug-step-fraction`, `tug-step-row`, `tug-text-card-editor`, `tug-transcript-entry`. **(verified: a read-only scan of every JSX tag that spreads `rest`; the scan is a line heuristic, so the list is a starting census, not a proof)**

**[F02] 13 library sites write a handler before `{...rest}`, so a caller's handler of the same name replaces it.** Arrow-key navigation: `tug-choice-group.tsx:476`, `tug-option-group.tsx:339`, `tug-radio-group.tsx:400`, `tug-tab-bar.tsx:862` (all `onKeyDown`). Editing: `tug-value-input.tsx:496` (`onFocus`, `onMouseUp`, `onKeyDown`, `onBlur`, `onContextMenu`), `tug-textarea.tsx:323` (`onChange`) and `:427` (`onContextMenu`), `tug-input.tsx:253` (`onContextMenu`). Copy menu: `tug-badge.tsx:341`, `tug-label.tsx:335` (`onContextMenu`). Others: `internal/tug-button.tsx:1293` (`onClick`, `onKeyDown`), `tug-popup-list.tsx:219` (`onScroll`). `tug-checkbox.tsx:335` and `tug-switch.tsx:310` write Radix's `onCheckedChange` before the spread. **(verified by the same scan; whether a caller's props type can still carry `onCheckedChange` was not checked)**

**[F03] `tug-accordion.tsx` is the working model.** At `:531-538` it spreads the root props and then writes `tabIndex` and `onKeyDown` after them, choosing between its own handler and the caller's. **(verified: read the file)**

**[F04] Which callers pass a handler that is replaced today is not known.** No census was taken of callers that pass `onKeyDown`, `onBlur`, `onContextMenu` and the rest to the 12 files in [F02]. A caller that relies on replacing the control's handler would change behaviour when the two are composed. (not measured)

**[F05] [L17]: the inline alert declares two alias-to-alias chains.** `tug-inline-alert.css:31-32` sets `--tugx-inline-alert-accent` to `var(--tugx-inline-alert-border)` and `--tugx-inline-alert-accent-icon-fg` to `var(--tugx-inline-alert-icon-fg)`. Each intermediate resolves to a `--tug7-` base token three lines above. **(verified)**

**[F06] [L20]: the settings group styles TugBox's parts and paints with TugPane's token.** `tug-settings-group.css` overrides `.tug-box.tug-settings-group.tug-box-bordered` padding, positions and paints `.tug-settings-group > .tug-box-legend` with `background: var(--tugx-pane-bg)`, and lays out `.tug-settings-group > .tug-box-body`. Its own header comment says "the box's own tokens are `TugBox`'s ([L20])". `TugSettingsGroup` has seven consumers. **(verified)**

**[F07] [L20]: the chip reads the atom and control token families directly.** `tug-chip.css:17-24` mixes `--tug7-surface-control-primary-filled-action-rest` into `--tug7-surface-atom-primary-normal-default-rest`, and takes its border and text from `--tug7-element-atom-*`. The header says the look is the `command-atom.ts` chip spec, "so a chip reads as an atom". The only other CSS file that reads atom tokens is `cards/about-card.css`; atoms themselves are painted from TypeScript. `TugChip` has one product consumer, `cards/session-pending-context-strip.tsx`. **(verified)**

**[F08] [L16]: none of the CSS files the consolidation added carries a `@tug-pairings` header.** Those that set colour: `tug-chip.css`, `tug-empty-line.css`, `tug-settings-group.css`, `cards/receipt-header.css`, `cards/sheet-header.css`, `cards/repo-notice.css`. `cards/receipt-header.css:34` and `cards/repo-notice.css:49` set colour with no `@tug-renders-on`. `cards/sheet-header.css:13` restyles `.tug-sheet-scaffold-header` and `cards/receipt-header.css:28` reads `--tugx-commit-subject-font`, both another component's. Across the library, 33 of 109 primitive CSS files lacked the header before the consolidation. (agent read during the audit; the three files quoted in [F05]–[F07] were re-read here, the rest were not)

**[F09] The token audit reads a hand list of 17 files.** `tugdeck/scripts/audit-tokens.ts:43-61`, `COMPONENT_CSS_FILES`, names 15 primitives and 2 gallery files. `tug-inline-alert.css`, `tug-settings-group.css`, `tug-chip.css` and every other file in [F05]–[F08] are outside it, which is why the lint lane passed them. How many violations a library-wide run reports is not known. **(verified: read the list; the wider count was not measured)**

**[F10] The guide shows code the consolidation removed.** `tuglaws/component-authoring.md:127` declares `onCheckedChange?: (checked: boolean) => void` in the reference props interface, and `:225-233` destructures and forwards it in the reference `TugSwitch`. `:441` and `:798` still show the per-kind `.tugx-file-header` rules the arc deleted. The file is 1,645 lines, up from 1,627 before an arc whose brief asked for it to be trimmed. **(verified)**

**[F11] The guide's root-element snippet already puts `data-slot` before `{...rest}`** (`:230`, `:235`), but no sentence states the order as a rule, and nothing says where a handler goes. **(verified)**

**[F12] The Overview answers `LAST_TURN` and not `FIRST_TURN`.** `tugdeck/src/components/overview/overview-card.tsx:1653` registers `LAST_TURN` (the jump button and ⌃⇧⌘]). `responder-chain-provider.tsx:1216-1224` maps End to `LAST_TURN` and Home to `FIRST_TURN`, sends each to the key card, and falls back to a generic region scroll when nothing answers. So End runs the Overview's jump and Home takes the fallback; ⌃⇧⌘[ in the Overview reaches no handler. The Session card registers both (`cards/session-card.tsx:4648-4651`). **(verified)**

**[F13] `at0367` is red on `main` on the path Home will use.** The Overview's reading line drifts when an older page is prepended; the cause is not found and the last green was 2026-10-18. (from the session's memory record, not re-run)

---

## Decisions {#decisions}

**[B01] Every primitive's root element has one order.** First the identity and the defaults: `ref`, the literal `data-slot`, state attributes, `className`. Then `{...rest}`. Then what the component must keep whatever the caller passed: its composed handlers and its invariant attributes. This one rule fixes [F01] and [F02] together, and it is the order `tug-accordion.tsx` already has ([F03]).

**[B02] The guide's `data-slot` rule stands; the 35 sites move to it.** A caller overrides `data-slot` through `...rest` ([F01]). The reverse, making the literal win everywhere and deleting the override from the guide, was the alternative and is rejected: 50 sites already allow the override, and consumers use it to tell two mounts of one primitive apart.

**[B03] Moving the spread is a per-site sort, not a text move.** At each of the 35 sites, every other literal that now sits after `{...rest}` is classed as a default, which moves above the spread so a caller can replace it, or an invariant, which stays below. The jump button's `aria-label` in the fixups arc was this same question answered once.

**[B04] A control composes a caller's handler with its own; it never lets one replace the other.** The control destructures the handler name it uses and writes a composed handler after `{...rest}`. A small `composeEventHandlers` in `internal/` runs the caller's handler first and the control's unless the caller called `preventDefault()`. That keeps a way for a caller to veto, and makes it an explicit act in place of an accident of prop order. It applies to all 13 sites in [F02].

**[B05] Callers are read before a control is composed.** For each of the 12 files, the arc lists the call sites that pass a handler the control also writes, and decides each one: the caller wants both to run, or it was relying on replacement and now says so with `preventDefault()` ([F04]).

**[B06] The checker gains the two order rules, with nothing on their allowlist.** One rule: a literal `data-slot` precedes `{...rest}` in the same tag. The other: no `on…` attribute precedes `{...rest}` in the same tag. Both are within the checker's existing line-and-regex design. They land after the sweep, so they start clean and hold the order from then on.

**[B07] The inline alert's accent tokens point straight at base tokens.** Each resolves in one hop to the `--tug7-` token its intermediate named ([F05]).

**[B08] The settings-group look becomes a TugBox variant.** The legend painted on the border, the padding that clears it, and the left-packed column body move into `tug-box.css` behind a TugBox prop, with a box-owned token for the legend's background in place of `--tugx-pane-bg`. `TugSettingsGroup` selects the variant and keeps at most its own width rule. Its seven consumers do not change ([F06]).

**[B09] The chip declares its own aliases and says it is an atom-family member.** `tug-chip.css` gains `--tugx-chip-*` tokens, each one hop to the atom or control base token it uses today, and its header states the family membership ([F07]). A `chip` slot across the ten theme files was the alternative and is rejected: its values would have to equal the atom's in every theme for ever, which is a copy with a drift risk and no theme that wants it different.

**[B10] The new CSS files get their headers, and the two cross-component reaches are removed.** The files in [F08] that set colour gain a `@tug-pairings` table, and the two unannotated rules gain `@tug-renders-on`. `cards/sheet-header.css` and `cards/receipt-header.css` stop reaching into another component, by the route [B08] takes: the owner grows what the consumer needs.

**[B11] The token audit reads the whole library, on a ratchet.** `COMPONENT_CSS_FILES` becomes a glob over the library's CSS. The violations a wider run finds in files this work touches are fixed; the rest are listed, and the audit fails on a new violation or a stale entry, as the conformance allowlist does. The user's call: "taking the ratchet for both" ([F09]).

**[B12] The `@tug-pairings` header is required of a CSS file that sets colour, on the same ratchet.** The older files that lack it are listed, not fixed here ([F08]). Same call as [B11].

**[B13] The guide is corrected, stated and trimmed.** Its checkbox and switch snippets are rewritten from the real files; the per-kind header strip rules are deleted ([F10]); [B01] and [B04] are written in as rules ([F11]). "Restoring saved state at mount" and "Stores That Observe CONTROL Push Frames", about 170 lines that are not about authoring a primitive, move to their own documents under `tuglaws/`. The guide ends shorter than the 1,627 lines it had before the consolidation.

**[B14] The guide's code is held to the [L11] list.** A check in the lint lane fails when a fenced block in the guide declares, in a props interface, a callback the checker's [L11] rule forbids. It is a narrow guard for the one way the guide has already gone stale.

**[B15] The Overview answers `FIRST_TURN`.** It scrolls to the top of the loaded column and releases follow-bottom, which is what the Session card's handler does. Home and ⌃⇧⌘[ then work there as End and ⌃⇧⌘] do ([F12]). One app-test asserts both keys.

---

## Open Questions {#open-questions}

- **How the box-owned legend background gets its value ([B08]).** The legend has to paint the surface the box sits on. TugBox's own pairing table names `--tug7-surface-global-primary-normal-default-rest`; the settings group paints `--tugx-pane-bg`. If the two resolve to the same colour in every theme, the token is a one-hop alias and nothing else is needed. If they do not, a box inside a pane needs a sanctioned way to be told its surface. Reading the ten themes settles which case this is.
- **Whether Home in the Overview makes `at0367`'s defect reachable from a key ([F13]).** Scrolling to the top may trigger an older-page prepend, the path whose reading line drifts. If it does, the drift is a defect this arc has surfaced on a new door and owns; if scrolling to the top of the loaded column prepends nothing, it is untouched. A reading in the running app settles it.

---

## Non-goals {#non-goals}

- **An AST-based checker.** [B06] adds two rules to the existing one. Replacing its regex rules with type-aware ones (a real root-element rule, [L11] driven by types, vocabulary checked by value set) is its own arc.
- **Paying down the ratchets.** [B11] and [B12] list the older violations and stop new ones. Clearing the lists is later work, by the user's call.
- **The callbacks the checker cannot see**: `onConfirm`/`onCancel` on the confirm popover, the list view's delegate channels, `onClick` inherited by `TugPushButton`, and the editor's `onFind…`, `onSaveCommand`, `onOpenPath`, `onJotDrop` and `onPastedOrigins`.
- **The 27 store-bound, unprefixed files still at the top level of the library**, and widening T02 to see stores whose module name has no `-store` in it.
- **The jump button's route around the command funnel ([L30]).** It dispatches `last-turn` directly. [B15] makes the two actions symmetric; it does not change how the button sends its own.
- **The rest of the audit's weaknesses**: unions still declared locally, `…Role` types used for tone props, the gauges' `compact` default, thin abstractions (`TugChip`, the `TugNamedIcon` component), hand-rolled point-menu state, and plan references left in docblocks.

---

## Exit {#exit}

An arc. The four parts are independent, with two orderings inside them: the caller census ([B05]) comes before any control is composed, and the two checker rules ([B06]) land after the sweep they hold.

A sketch of the work:

1. Add `composeEventHandlers`; read the callers of the 12 files; compose the 13 handler sites ([B04], [B05]).
2. Sort and move the 35 `data-slot` sites ([B02], [B03]); add the two checker rules and a table-driven test that renders each primitive with a caller `data-slot` and a handler spy ([B06]).
3. Fix the inline alert, the chip and the new files' headers; move the settings-group look into TugBox; glob the token audit and write both ratchet lists ([B07]–[B12]).
4. Correct and trim the guide, and add its guard ([B13], [B14]).
5. Give the Overview `FIRST_TURN` and its app-test ([B15]).

Steps 2 and 3 change what many primitives render, so the style census app-tests (`at0798`–`at0804`) are their verdict; step 5's app-test is the other slow run. Everything else is the fast lane.
