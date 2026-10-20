# A card is one view

**Purpose:** A dragged card's content detaches from its own title bar and masthead, and the drag leaves holes in the cards it crosses. Both come from one structural fact: a card's chrome and its content are drawn by two renderers that share no frame. This brief moves the chrome into the card's own page so a card is one layer tree the host moves natively, makes the shell the canvas beneath the cards, and deletes the hole model.

---

## Purpose {#purpose}

The report, in the user's words:

> When dragging a card, the card content can become detached from its frame/titlebar/masthead. This is a BAD BAD bug. This must never ever happen, not even for a single frame. There's something basically flawed about our model that this can occur — some structural/design flaw that allows these items to be out of sync with each other. The dragging can also leave *holes* in the cards that were dragged over, which speaks to how we don't know when areas of the deck/canvas/cards are invalidated and must be redrawn. All this is *fundamental*. MUST FIX.

Three screenshots showed it: a Session card in the hand with its masthead at one position and its transcript a pointer frame or two away; the floor grid showing through the card's rect where its body had already left; and a neighbouring card keeping a cut after the drag crossed it.

The user's standard is the invariant, not a tolerance: chrome and content of one card may never disagree, for any frame. A snapshot-in-hand stopgap was sketched and rejected in favour of the correct model, with no delay.

---

## Evidence {#evidence}

**[F01] A card's chrome and content reach the screen through two pipelines with no shared commit.** The chrome is DOM in the shell page: `tug-pane.tsx` writes `frame.style.transform` on every pointer event of a drag (around lines 3990 and 4140), and that reaches the screen through WebKit's rendering update, a layer-tree flush to the UI process, and a Core Animation commit. The content is a separate `WKWebView` beneath the shell page. In the same pointer handler, `bodyFollowFrame` (`body-placement.ts`, `follow`) reads the placeholder's rect, posts `placeBodies` to the host, and `BodyViewController.place()` sets the body view's frame inside a `CATransaction` with actions disabled, which commits at the end of that run-loop turn. Nothing pairs shell frame N with host transaction N. **(verified, by reading both sides)**

**[F02] The content usually leads the chrome.** The host's transaction commits in the same run-loop turn the message arrives; the shell's transform still has a rendering update and a flush ahead of it. So the body moves first and the chrome catches up a frame or more later. This is inference from the pipelines, consistent with the screenshots, not measured with a frame sampler. A rAF recorder over `lab.drive` on a live drag would confirm the lead.

**[F03] The hole is a third position for the same card.** Every pane behind a visible body wears an even-odd `clip-path` with a hole at that body's rect (`paneClipPath`, `cutPanes`), rewritten in the shell's DOM on the same pointer frame as the transform. When the body has moved and the chrome has not, the old hole shows the host's floor grid through it, which is the second screenshot. **(verified)**

**[F04] Holes left on neighbours are stale cuts.** `follow` re-cuts the panes behind the dragged body each frame. The cut is cleared only by a measurement (`land` → `schedule` → `measure` → `cutPanes`), and `measure` declines while a set-up is pending or the container is settling (`lastSkip`). A drag that ends into a settle leaves the last drag frame's cut on the panes it crossed until the next measurement that is not declined. **(verified, by reading; the specific stale path was not reproduced)**

**[F05] The settle path met the same bug and was patched with a shared clock.** `bodyRunPlan` and `beatPlan` hand the host each beat's rects, curve and delay from a start both sides know, and the host runs the body's container as Core Animation on it. That is a pairing of two pipelines by timestamp, which a drag, driven by pointer events with no plan, cannot have. **(verified)**

**[F06] The hole model is a large body of code that exists only because the shell paints over the cards.** `body-placement.ts` is 1,434 lines, `body-beat-plan.ts` 635, `BodyViewController.swift` 1,213 and `BodyGeometry.swift` 230, with the grip hit regions, lids, cuts, cut keyframes, in-flight beats and `follow` among them. `shell-surface.ts` (476 lines) exists because a body's popover cannot paint past its view, so the shell draws it. The body right-click menus failing (`at0307`, `at0346`, `at0560`, `at0568`, `at0599`) are host hit-testing landing on the shell's placeholder `DIV` inside the body's rect, the same layer order. **(verified)**

**[F07] The chrome is one large shell component.** `tug-pane.tsx` is 5,980 lines: title bar, tab bar, masthead slot, resize grips, banners, fold form, the drag, drop-zone indication, sash and settle hooks. 107 app-test files read pane chrome through shell selectors (`data-pane-id`, `tug-tab-close-*`, `tug-pane-title`, `tug-pane-resize`). **(verified, by `wc` and `grep`)**

**[F08] The bus already carries half of what the chrome needs, per card.** `card.context` (folded, arriving, first responder, layer shown, space id, rail side, parked) and `card.crossing` are shell-owned card-scoped stores; `card.facts`, `card.holds`, `card.reservations` and `card.surface` are card-owned. `pointerClaim` exists for a body to take a pointer from the host. The host already stacks body containers in pane order (`sortContainers`) and focuses one view at a time. **(verified)**

---

## Decisions {#decisions}

**[B01] A card is one view: its pane chrome renders inside the card's own page.** Title bar, tab bar, masthead slot, resize grips, banners and the fold form render in the body page, so chrome and content are one layer tree. The host moves that view as a unit, in one Core Animation commit. Disagreement between a card's chrome and its content becomes impossible by construction rather than by timing. This is the invariant the user set, and no arrangement of two renderers meets it.

**[B02] The shell becomes the canvas beneath the cards.** The shell page holds the floor, the grid, the arrangement authority, the drop-zone indication and the workspace layer. It paints nothing over a card's rect, so there is no lid to lift, no hole to cut and no placeholder for the host to hit-test. The host's floor view and the shell's canvas merge into one layer, which is the shell page, so the `floorGrid` and `floorShown` hand-off goes.

**[B03] One web view per card stays; a pane with tabs is N card views at one rect.** The active card's view shows and draws the pane's chrome; the others are hidden at the same rect. Per-card keeps a tab move between panes a placement change rather than a content hand-off, keeps process isolation per card, and keeps every piece of the shell-body API as it stands. Per-pane views were considered and are a non-goal.

**[B04] The pane's chrome state is a shell-owned, card-scoped store.** Tab set (ids, titles, activities), active card, pane title, closable, which grips the pane offers, pinned side and family: declared in `bus/declarations/`, registered, codec-checked, snapshotted on attach with `after` where a reader depends on order, and tested on `createTestBus()`. Every chrome gesture that changes arrangement (activate tab, close, add sibling, fold, start a drag, start a sash) is an action or request to the shell, which already owns the arrangement. The hub law holds: a body never addresses a sibling, and the shell projects what each card needs of its pane.

**[B05] Motion is the host's, from the shell's plan, and only at whole-card granularity.** A title-bar drag is the body claiming the pointer and the host moving the view on each mouse event. A settle is the host running a frame animation per card from the shell's plan, which is what the beat runner does today for bodies, now for whole cards. A sash drag resizes the view live; the page inside reflows as a native window does. The shell computes arrangement and rest geometry and posts it; it writes no per-frame transform for any card. Tearing within a card cannot happen. Two cards disagreeing by a frame during a window resize is accepted, as it is today.

**[B06] A transparent overlay web view holds transient surfaces and nothing else, and never tracks a moving card per frame.** A body's surface escaping its box, drag guides and drop indication, the space layer's transition, the command palette and any shell-raised sheet live in an overlay view above every card. It is hit-test transparent when it holds nothing, and claims the pointer only inside a surface it shows. The rule the user approved: nothing in the overlay may follow a moving card frame by frame. A surface anchored to a card is dismissed, or hidden, when that card starts to move and re-shown at rest. Drag indication draws against drop zones, which are stationary, not against the card in the hand. This is the one new structural element and the one place tearing could creep back; the rule is what keeps it out, and a test on the overlay's census enforces that no surface in it holds a per-frame subscription to a card's geometry.

**[B07] The hole model is deleted, not hardened.** Even-odd pane cuts, cut keyframes, `follow`, `land`, per-frame `placeBodies`, `bodyRunPlan`/`beatPlan`, in-flight beat tracking, the host's grip hit regions and `near()` landing checks, the lid except at first paint, `shell-surface.ts` as a shell-drawn mirror of a body's surface, and the host-drawn floor. The first-paint lid stays in the card's own page: a card shows its chrome at once and its content once painted, which is the paint gate's job today. Deleting is the point: every one of these exists to reconcile two renderers that will no longer need reconciling.

**[B08] Host hit-testing follows the view, not a placeholder.** With no shell DOM at a card's rect, a pointer over a card is the card's, and the body right-click class of defects closes without a fix of its own. The grips are the card's own DOM and claim nothing from the host.

**[B09] The app-tests move with the chrome.** Every read of pane chrome goes through `App.body(cardId)`; a shell-document read is only of the canvas, the overlay, or to prove the shell did not take something, with `// card-dom: shell` as today. `just app-test-body-scope-check` gains the chrome selectors. The bodies-migration brief's [B30] thread is folded into this work rather than resumed on the old layer order; its remaining reds (`at0527`, `at0600`, the right-click files) are re-read against the new model before any is fixed on the old one.

**[B10] No stopgap.** The snapshot-in-hand sketch (a picture of the body carried inside the shell's frame during motion) was rejected: it is days of work entirely deleted by this model, and it treats the layer order as fixed when the layer order is the flaw. The detachment stands on the user's deck until this lands, by the user's decision.

**[B11] The shell-body API is the foundation, not a casualty.** The bus library, every declaration, the registry test, `createTestBus`, the handoff and lifecycle, the paint gate, the close decision, the keyboard yield, host focus per view and the host's container stacking all stand. This model needs more state to cross per card, and the bus is the instrument built for exactly that. A chrome gesture is a declared action; a chrome fact is a declared store; both are tested as exchanges between pages.

---

## Open Questions {#open-questions}

- **Which transient surfaces move to the overlay and which to the card.** A body's popover that fits inside its card can stay in the card; one that escapes goes to the overlay. The census of today's `shell-surface` users and `canvas-overlay-registry` users decides each. Settled by reading, at the door.
- **Drop-zone indication during a drag.** The host moves the card; the shell computes the zone under the pointer from the host's reported position and draws the indication in the overlay against the zones. One crossing per pointer frame for indication only, lagging a frame, is acceptable; whether the hit-testing itself should move to the host is a performance reading to take once it works.
- **Live resize fidelity.** A sash drag resizes a web view live and the page reflows per frame. Whether WebKit keeps up at the deck's sizes, or the card should hold a pinned layout during the drag and reflow at rest, is a measurement, not a decision.

---

## Non-goals {#non-goals}

- **The snapshot stopgap.** Rejected, [B10].
- **One web view per pane.** Rejected: it makes a tab move a content hand-off, drops per-card isolation, and reopens the per-card decision ([B03]).
- **Pairing the two pipelines by timestamp for drags.** A pointer-driven motion has no plan to share, and [F05] shows the pairing is a patch even where a plan exists.
- **Keeping any shell paint over a card's rect.** Lids, holes and placeholders are the model being removed; a "small" one kept for convenience is the tearing seam returning.
- **An overlay surface that follows a card per frame.** Forbidden by [B06].
- **Changing the bus primitives.** Three primitives, one envelope, tugcast reading nothing.

---

## Exit {#exit}

An arc. The order the pieces must land in:

1. **The pane chrome store and its verbs.** Declare the per-card pane state and the chrome actions and requests; register and test them on `createTestBus()`. The shell publishes them from its arrangement; nothing reads them yet.
2. **Chrome in the body page.** `tug-pane.tsx`'s rendering half moves into the body page, reading the replica; the first card kind to carry it is the Session card, then every kind. The shell's pane renders no chrome for a body card. The paint gate reveals the card with its chrome.
3. **The shell beneath.** The host reorders the layers: shell page at the bottom, cards above, the overlay view at the top. The host's floor is retired into the shell's canvas. Lids and cuts go.
4. **Motion to the host.** Title-bar drag by pointer claim and native move; settles as whole-card frame animations from the shell's plan; sash resize live. `follow`, `beatPlan` and the beat runner's body-only form go.
5. **The overlay.** Transient surfaces move in under [B06], with the per-frame-tracking guard.
6. **Deletion and the tests.** `body-placement.ts`, `body-beat-plan.ts`, `shell-surface.ts` and the host's geometry split are removed; the 107 chrome-reading app-tests move to `App.body`; the right-click files and the [B30] reds are re-run on the new model.

The verdict at each stage is the unit suite, lint, and the derived app-tests, with the core tier once when the layer order changes (stage 3) since that touches what runs before any test's first assertion.

*Landed in two halves (2026-10-19, the user's call):* the arc walked seven of its nineteen steps (stages 1 and 2 for the Session, rail and document kinds; the host gesture live) and was joined to `main` as `feee863b8` at that boundary, so that its remaining steps could be rewritten on a typed host channel instead of adding to a hand-parsed one. `briefs/host-channel-and-body-deck-brief.md` lands that channel, `CardDeck` and `deck.cards`; `briefs/shell-beneath-the-cards-brief.md` carries this brief's remaining stages on them, inheriting [B01] to [B11] and the arc's dated resolutions. Five app-tests the arc's steps never named were red at the join and are owned by the successor's first step: `at0347-stack-badge-picker`, `at0710-zoom-same-layout`, `body-grounding/row-28-deck-facts`, `row-06-menus-kinds-shows`, `row-07-focus`.
