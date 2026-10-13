<!-- brief-skeleton v1 -->

# Every card a body: the other card kinds, the shell's diet, lifecycle and the cap, the harness sweep, and the law

**Purpose:** After stages 2–4 a Session card lives in a body and every other card still mounts in the shell's document, two code paths run for one thing, the harness addresses one view by default, and no law names the shape. This brief moves every card kind into a body, removes the in-document card path and what only it needed, rules lifecycle and the ceiling on live bodies, migrates the tests that reach across documents, and writes the law.

Stage 5 of `briefs/per-card-web-views-program-brief.md`.

---

## Purpose {#purpose}

The user: "one WKWebView per card." This stage is where that becomes true for every card and where the single-document deck stops existing.

---

## Evidence {#evidence}

**[F01] The card kinds.** Registered in `main.tsx:516-541`: session; hello, about, settings, keyboard (`components/tugways/cards/*`); devtools (`devtools-card.tsx:99`); text (`text-card-registration.tsx:67`); file-view (`file-view-card-registration.tsx:47`); diff (`diff-card.tsx:391`); commit (`commit-card.tsx:303`); and the five sidebar cards with `layoutRole: "sidebar"`: jots, overview, arcs, cards, layout (`components/{jots,overview,arcs,cards,layout}/*-registration.tsx`). Sub-tabs devtools-tab, help-tab, permission-rules-tab; gallery, spike and fixture cards load lazily (`main.tsx:378-394`). Singletons `about`, `settings`, `keyboard`, `spike-home` (`action-dispatch.ts:1158`). **(verified, read)**

**[F02] The sidebar cards read the whole deck.** The Overview, Cards and Jots cards subscribe to app-scoped stores attached in `main.tsx:805-857` (`attachOverviewStore` `:824`, session activity `:829`), read every session, and the Overview's composer inserts into another card's prompt (`overview-insert-target.ts`, `useSessionPromptInsertTarget`); the Layout card's rows drive the imposition. The Overview's parked twin was the largest parked population (7,963–8,300 elements) in stage 6's readings. **(verified, read)**

**[F03] Lifecycle is one view's.** WebContent termination reloads the one page with a 10 s guard (`MainWindow.swift:1751-1782`); `.reload` freezes, calls `tugdeck.saveState`, then loads (`:1784-1820`); quit freezes with a snapshot, runs `prepareForTermination` with a 12 s deadline, then `cleanupBridge` and tugcast shutdown (`AppDelegate.swift:573-670`); a tugcast restart re-authenticates the one page in place (`:449-451`). **(verified, read)**

**[F04] The harness and the corpus assume one document.** 481 app-test files; about 207 contain both a chrome selector and Session-card inner DOM, 37 on one line, 55 call `document.querySelector` on Session DOM directly, about 70 touch transcript DOM; `_harness/selectors.ts` `cardHost()` is imported by 11; `window.__tug` is touched 1,523 times, `__tugMotion` 42, `__tugBridge` 31, `__tugIngest` 17. Selection is by `@covers` (`tests/app-test/scripts/select-tests.ts`), capped at about 20 files, with core-tier triggers on `_harness/`, the Swift harness, `main.tsx` and `index.html`. **(verified, counted)**

**[F05] What stage 2 left double.** `CardHost`/`CardPortal` for in-document cards beside the placeholder for bodies; `selection-guard.ts` (retired in stage 4 for bodies, alive for in-document cards); the still-crossing hold and `resize-episode` for in-document cards; `SHOWN_PANE_FRAMES`-based census in `__tugMotion`; the eval door's default target. **(verified, read)**

**[F06] A WebContent process has a resting cost.** Stage 2's spike reads it; the single process stood at 2.9 GB on the user's deck with twenty panes. **(the per-process number is owed to the spike)**

---

## Decisions {#decisions}

**[B01] Every card kind becomes a body, in this order.** The Overview first, because it is the largest and already windowed; then Cards, Jots, Arcs and Layout, whose cross-deck reads become bus and tugcast subscriptions (stage 1 [B04]'s all-sessions subscription for Overview and Cards; `card-command {insert-prompt}` to a Session body for the Overview's composer; `deck-command` to the shell for the Layout card's rows); then text, file-view, diff, commit, devtools; then the singletons and hello. The gallery, spike and fixture cards follow the same path because the harness mounts them. A rail is a pane like any other and its card a body like any other.

**[B02] The shell's diet.** Once no kind mounts in the document: `CardHost` renders only placeholders; `CardPortal`, `pane-content-registry`, `selection-guard.ts`, `registerCrossingInterior` and the crossing CustomEvents, `resize-episode`'s in-body dispatch, the ingest hold on the shell's connection, the Overview window's document reads, and the in-document arrival quiet all leave. The shell subscribes to no session feed; its mastheads read `card-facts`. The shell's census on the user's deck is read before and after and goes in the record; the target is the chrome alone, a few thousand elements that do not grow with the day.

**[B03] Lifecycle per body.** A body whose WebContent terminates is reloaded alone, with the shell told so it can show the pane's restoring state; the shell's termination reloads the shell and re-places every body. `.reload` (⌘R) freezes the window, fans `saveState` to every page, reloads all, and the shell re-creates bodies from the layout. Quit fans `prepareForTermination` to every page under one 12 s deadline, bodies first, then the shell. A tugcast restart re-authenticates the shell, whose cookie every body shares, and every page reconnects. Closing a card destroys its body and its process.

**[B04] The cap: parked bodies unload past a budget.** Hidden bodies (parked workspaces, folded cards past a count, cards scrolled out of a stack) are the first to be unloaded: the host destroys the view, the body's state bag and session seating stay in tugbank and tugcast, and the body is re-created on reveal behind the arrival's reveal gate. The budget is a number of live bodies and a resident-memory ceiling read from the spike's per-process cost, set in `.tugtool/config.toml` and the Layout card, with a default the reading justifies. A session keeps running in tugcast whether or not its body is loaded; this is what stage 6's [B06] was reaching for.

**[B05] The harness sweep.** `App.body(cardId)` (stage 2 [B08]) is the only way a test reaches a card's DOM; `cardHost()` and the shared selectors become body-scoped; the 207 mixed files are migrated by a codemod that rewrites a `document.querySelector` whose selector enters a card's DOM into the scoped form, with the 37 single-line cases and whatever the codemod cannot prove rewritten by hand; `@covers` keeps selection scoped as each file lands. A file that cannot be migrated is deleted with its reason in the commit, not carried red. The core tier runs once after the harness changes, as the advisory says.

**[B06] The instruments address pages.** `tugtool deck motion` verbs take `--card`; the gap sampler, `__tugMotion` and the census run in every page and the verb prints them per page beside the window's frame row; `deck motion gaps` reads every page's ring; `deck motion walk` prices each body's document. The eval door's `--card` from stage 1 is the only way to evaluate in a body.

**[B07] The law.** A new `tuglaws/shell-and-bodies.md` names: one shell, one body per card, one process each; the host as arbiter of first responder and mover of bodies; the shell as the authority on arrangement; the three channels and what each carries; set-up-and-go as executed in two places on one clock; the cap and the unload rule; what a test may assume about documents. `tuglaws.md` gains the law lines; `design-decisions.md` the reversals: the one-document deck, cross-card selection, the in-page settle moving cards, the ingest hold as a deck-wide hold. The program brief's [B07] escape clause from the headroom program is closed as taken.

**[B08] The record is finished.** The program record's final row: the four gestures on the user's aged deck with three streams, processes and resident memory with twenty cards open, the shell's census, and the window's frame reading, beside the before.

---

## Open Questions {#open-questions}

- **Does the Layout card stay a body?** Its rows drive the shell's imposition and it is small; a body for consistency, by [B01], unless the reading shows its bus round trips in a resize as a cost. Decided in the arc.
- **What is the default cap?** The spike's per-process cost against the machine's memory; written beside the setting.

---

## Non-goals {#non-goals}

- **Keeping an in-document path for any card.** One shape, as the user asked; a card that cannot be a body is a defect to fix, not an exception.
- **Compatibility shims in the harness.** Migrated, not bridged.
- **Changing what any card shows.** Only where it runs.

---

## Exit {#exit}

**An arc.** The shape: the Overview and the sidebar cards ([B01]), each read on the user's deck as it lands; the remaining kinds; the shell's diet ([B02]) once the document is clear; lifecycle and the cap ([B03], [B04]); the harness sweep ([B05]) and the instruments ([B06]) alongside; the law and the record last ([B07], [B08]). It joins when no card mounts in the shell's document, the corpus is green on `App.body`, and the record's final row is written.
