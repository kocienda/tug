<!-- brief-skeleton v1 -->

# Fix the six defects the component-library consolidation left on main

**Purpose:** The consolidation of the tugways component library landed as `65742885b` with `just lint-audit` red on `main`, one visible styling regression, and four smaller defects in the controls it converted. These are fixed before anything builds on the new library.

---

## Purpose {#purpose}

An audit of the join, run on `main` on 2026-11-12, asked whether the work could be moved on from with confidence. The answer was no, for six local reasons. The user's call:

> brief the must-fix items. we'll handle the should-fix as a follow-on arc as you suggest.

The arc claimed three things it did not fully deliver: that no change is visible, that a checker holds the library to the authoring guide, and that every converted control still works wherever it is mounted. Each item below is a place where one of those claims is false today.

---

## Evidence {#evidence}

**[F01] `just lint-audit` is red on `main`.** `bun run audit:components` reports five problems, all in `tugdeck/src/components/tugways/tug-workspace-name-dialog.tsx`: C01 (no exported `TugWorkspaceNameDialogProps`), C03 (no `forwardRef`), C05 (no `cn()`), C06 (no `{...rest}`) and G01 (no gallery card). Every other check in the lane passes. The file came in with `7039135b6`, the `workspace-naming-modal` join that landed directly beneath the consolidation. **(verified: ran the lane on `main`)**

**[F02] That file is a feature, not a primitive.** It takes no props, asks one app-specific question (a workspace's name for New and Duplicate), and reads `lib/workspace-name-request.ts`, a domain singleton. The checker's store rule (T02) does not flag the import because the module's name has no `-store` in it. Its consumers are `components/tugways/app-gates.tsx` and `overlay/overlay-census.ts`, and four app-tests name it: `at0582`, `at0586`, `at0656` and `body-grounding/row-44-switch-create-modal`. **(verified: read the file and its importers)**

**[F03] The conformance audit is not part of the join gate.** The `deck` surface in `.tugtool/config.toml` checks `tugdeck/` paths with `bunx tsc --noEmit`, `bunx vite build`, `just test-ts` and `just app-test-changed {paths}`. `just lint-audit` is in none of the surfaces. The test ledger shows the arc's last `lint-audit` pass at 00:52 on 2026-11-12, before the base moved under it; the re-audit that followed the base move ran the fit check, which does not include the lint, so two arcs that were each green produced a red `main`. **(verified: read the config and `tugtool test last`)**

**[F04] The empty-workspace line in the Cards card lost its styling.** `tugdeck/src/components/cards/cards-card.tsx:746` renders `<span className="rail-card-empty cards-empty">` for the "None" / "No matches" row under an empty workspace. Before the join, `.cards-empty` in `cards-card.css` carried the look (flex, centred, 28px minimum height, 10px inline padding, 12px subtle text). The join moved those declarations into `.tug-empty-line` and deleted `.cards-empty`; nothing defines `rail-card-empty`. The one rule left, `.cards-space-empty > .cards-empty` at `cards-card.css:624`, only sizes the line and its comment says the voice is `.tug-empty-line`'s, which this span does not wear. The card's other empty line, at `cards-card.tsx:1898`, is a real `TugEmptyLine` and is unaffected. **(verified: read both revisions; not observed in the running app)**

**[F05] The style census did not catch [F04].** The census app-tests `at0798`–`at0804` hold moved CSS to computed values recorded before each move, and the `list-surfaces` family reads the Cards and Jots lists. The empty-workspace row was not among its readings. (inferred from the brief's own resolution notes and the regression existing; which elements the family reads was not checked line by line)

**[F06] The file chooser's Browse can throw after its host is gone.** `tugdeck/src/components/tugways/tug-file-chooser.tsx:162-171`: `browse` awaits `pickPath(...)`, the system file panel, and in the `.then` dispatches `set-value` twice through a `dispatch` that captured its parent responder when it was created. A targeted dispatch to a responder that has unregistered throws (`responder-chain.ts`, `sendToTargetForContinuation`). If the host closes while the panel is up (Open Quickly dismissed, a Configure Tug step advanced, the card closed), the result is an unhandled promise rejection. Before the join this path called `onChange(path)`, a no-op on an unmounted component. (agent read of the code; the throw was not reproduced)

**[F07] The gallery's find bar cannot be closed and swallows Escape.** `tugdeck/src/components/tugways/cards/gallery-tug-find-bar.tsx` mounts `TugFindBar` with no host from `useFindBarHost`, so the bar's new `close-find` dispatch reaches no handler. The query field's Escape keymap still reports the key handled (`tug-find-bar.tsx`, near line 305), so Escape is consumed and does nothing; the close button is dead too. (agent read; the gallery card file was confirmed to mount no host)

**[F08] `TugJumpToBottomButton` discards a caller's `aria-label`.** `tugdeck/src/components/tugways/tug-jump-to-bottom-button.tsx:61-76` spreads `{...rest}` first and writes `aria-label="Scroll to latest"` after it, so the literal wins. The gallery card passes `aria-label="Jump to latest"` and it is dropped. The authoring guide's vocabulary table names `"aria-label"` as the accessible-name prop. **(verified: read the component)**

**[F09] What is sound, and stays as it is.** `just test-ts` is green on `main` (the tugdeck suite plus the app-test logic suite). No reference to any deleted component remains outside historical records. Every former callback site has an equivalent chain handler, and the host scopes `useFindBarHost` and `useFileChooserHost` return are identity-stable. `at0370` natively clicks the Overview's jump button and was green on the arc's conversion commit. **(verified, except the callback-site census, which is an agent read)**

---

## Decisions {#decisions}

**[B01] `tug-workspace-name-dialog` leaves the primitive tier.** It moves out of the top level of `components/tugways/` and loses the `tug-` prefix on its file and its exported symbol, as the consolidation did for every other store-bound feature ([F02]). Its CSS classes, `data-slot` values and test ids stay as they are, the rule the consolidation followed, so the four app-tests that name it keep passing unchanged. Conforming it in place was the alternative and is rejected: a prop-less component that asks one app question is not a library control, and a gallery card for it would document nothing reusable.

**[B02] `just lint-audit` joins the `deck` surface's fit check.** The lane takes about seven seconds, so its cost at a join is nothing next to the build and test runs already there. This is the fix for the class of failure, where [B01] fixes the instance: without it the next arc that adds or moves a `tug-*` file under another arc's feet lands red the same way ([F03]).

**[B03] The empty-workspace line becomes a `TugEmptyLine`.** The span at `cards-card.tsx:746` is replaced by the primitive, keeping the `cards-empty` class so the sizing rule at `cards-card.css:624` still applies. Restoring a private rule for the span was the alternative and is rejected: it would be the hand-rolled copy the primitive exists to replace ([F04]).

**[B04] The style census reads the element [B03] fixes.** The `list-surfaces` family gains a reading of the empty-workspace line, with its expected values taken from the base before the consolidation (`65742885b^`), so the assertion is the proof that [B03] restored the old look and not merely a look ([F05]).

**[B05] The file chooser's Browse does not dispatch to a host that is gone.** The `.then` checks that the chooser is still mounted and its target still registered before it dispatches, and does nothing otherwise, which is what the callback did before the conversion. The guard lives in the chooser, not in the chain: a targeted dispatch to a missing responder throwing is the chain's contract and catches real wiring errors elsewhere ([F06]).

**[B06] The gallery's find bar gets a host.** The gallery card registers one through `useFindBarHost` and answers `close-find`, so the card demonstrates the bar the way a real host uses it, and Escape and the close button work ([F07]). Changing the bar to pass Escape through when nothing answers was the alternative and is rejected: a find bar with no host is a wiring error, and the gallery is where correct wiring is shown.

**[B07] A caller's `aria-label` wins on the jump button.** The component's label becomes a default the caller's replaces ([F08]).

**[B08] Each fix lands with the assertion that would have caught it.** [B01] and [B02] are proven by `just lint-audit` going green and staying in the gate. [B03] is proven by [B04]. [B05] gets a unit test that resolves the pick after the host has unmounted and expects no throw and no dispatch. [B06] and [B07] get assertions in the existing gallery or component tests. A defect fixed with no assertion is a defect that can come back the way these arrived.

---

## Non-goals {#non-goals}

- **The should-fix list from the audit.** Deferred by the user to a follow-on arc: the `{...rest}` and `data-slot` ordering across the library, caller handlers that replace required internal behaviour, the token-law gaps in the new CSS ([L16], [L17], [L20]), the stale reference snippets in `tuglaws/component-authoring.md`, and the End/Home asymmetry in the Overview.
- **A stronger checker.** The conformance rules are shallow by design and the audit recommended an AST-based replacement. That will surface a batch of new violations and belongs with the follow-on arc, not here. [B02] makes the existing checker enforced; it does not make it stronger.
- **Teaching T02 to see `workspace-name-request`.** The store rule matches on module names containing `-store`, which is how this import slipped past. Widening it is checker work for the follow-on. [B01] removes the one file where it mattered.
- **Moving the remaining unprefixed features out of the top level.** The audit counted 27 store-bound, unprefixed files still at the top level of `components/tugways/`. That is the tier boundary half-drawn, and it is the follow-on's to finish.
- **Converting the callbacks the checker cannot see** (`onConfirm`/`onCancel` on the confirm popover, the list view's delegate channels, `onClick` inherited by `TugPushButton`).
- **Re-checking `at0213` and running the core app-test tier.** The join message lists `at0213` as red on unchanged `main` and the re-audit skipped the core tier. Neither is one of the six defects; whoever walks this arc runs what its own changes select.

---

## Exit {#exit}

An arc. The six fixes are independent of each other and each is local to one or two files, so their order is free with one exception: [B02] goes last or together with [B01], because adding the lint to the gate while `main` is still red would refuse the arc's own join.

A sketch of the work:

1. Move and rename the workspace name dialog ([B01]); `just lint-audit` goes green.
2. Replace the empty-workspace span with `TugEmptyLine` and add its census reading against the pre-consolidation base ([B03], [B04]).
3. Guard the file chooser's Browse and test it ([B05]).
4. Give the gallery find bar a host ([B06]) and let the caller's `aria-label` win on the jump button ([B07]), each with its assertion.
5. Add `just lint-audit` to the `deck` surface ([B02]).

The census reading in step 2 launches the real app, so it is the one slow verdict in the arc; everything else is the fast lane.
