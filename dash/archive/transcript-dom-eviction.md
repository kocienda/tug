# Transcript DOM eviction — the measured-height ledger {#top}

Written 2026-08-01, out of the S9 memory attribution (see [aug01-perf-brief.md §S9](aug01-perf-brief.md#s9-wake-stall)). The governing constraint, set explicitly by the user: **the transcript looks identical — this is a footprint optimization, not a redesign.** No fold bands, no new chrome, no visual state the user has to learn. Every pixel the deck shows today, it shows after this lands.

## The finding this answers {#finding}

The `{lastTurns: 25}` restore window is bounded in turns, but a turn does not bound content: autonomous-session turns carry up to 250 tool calls each. Measured on the live release deck (2026-08-01): **1,372 collapsed tool-block headers mounted, 40,359 of the transcript's 64,023 nodes**, top entries at 8,242 / 6,051 / 4,865 nodes while the median entry is 107. Each mounted node bills a WebCore element + render object + computed style + React fiber + props — the mounted *representation* of the transcript is ~10× the data it presents, and it is the dominant addressable share of the ~730MB live WebKit-malloc heap and the feedstock of the ~520MB steady graphics backing. The store's row models are small and honest; the DOM is the amplifier.

## The concept: traverse, don't reside {#concept}

A settled transcript row's DOM exists for one of two reasons: the user can see it, or it is about to yield its measured height. Otherwise it is evicted — replaced in the list by a placeholder that occupies its **exact previously-measured height** and paints nothing. The row's data stays in the code-session store (unchanged, [L02]); its DOM traverses memory (mount → measure → evict) but does not reside in it. Re-mounting is driven by scroll proximity or a user gesture, from data already resident — no fetch, no re-parse, no tugcode round trip.

This extends a contract the transcript already has. `TugListView`'s `offscreenSkip` path mounts every cell, measures it with a per-cell ResizeObserver, stamps the exact height as `contain-intrinsic-size` + `data-cv-ready`, and lets `content-visibility: auto` skip offscreen *paint and style* (`tug-list-view.tsx` ~2099–2126). A cv-skipped cell already paints nothing, so an evicted placeholder is pixel-identical to today's skipped cell. Eviction promotes the cv stamp into a **ledger that survives unmounting**, and extends the skip from paint to existence: DOM, render objects, computed styles, fibers all released.

## Invariants {#invariants}

- **I-1 Pixel identity.** An evicted row's placeholder has the row's exact measured height and paints nothing — indistinguishable from today's cv-skipped cell. Scrolling, revealing, expanding all look exactly as they do now.
- **I-2 Real heights only.** Every ledger entry was once rendered pixels, measured by the same ResizeObserver stamp cv uses today. No estimated heights, ever (the standing no-height-estimates rule; this design is windowing *with the estimate problem removed*, which is why the original windowing pivot-out does not apply).
- **I-3 The store is truth.** Row models never leave the code-session store; eviction is purely a mounting policy in the view layer. Nothing about ingest, replay, or the store's shape changes. ([L02], [L24] — the mounted set is view-zone state.)
- **I-4 User-visible state is never destroyed by eviction.** Rows that host focus, the descend scope, an active selection endpoint, a find match, in-flight streaming, or a stateful embed are pinned — never evicted. ([L23])
- **I-5 User gestures re-mount synchronously.** A click that needs a row (expand, reveal) mounts it in that event's commit — single-row mounts are milliseconds and user-initiated, so they price below perception.

## Eviction policy {#policy}

**Unit.** Phase E1: the transcript row (the `TugListView` cell — one entry). Phase E2 (only if E1's residual demands it): block-runs *within* an entry taller than ~3 viewports, same ledger keyed by block id — a whale entry's offscreen portion evicts while its onscreen portion stays mounted. E1 first because most whale entries are wholly offscreen most of the time (measured: 174 of 182 cells offscreen-skipped on the live deck).

**Mounted set.** Rows intersecting the scrollport ± the mount margin (1 viewport each way) are mounted. An IntersectionObserver with that rootMargin over the cells drives mounting — this is new JS machinery (cv's skip is engine-managed and needed none), and it observes DOM directly per [L22], batching mount-set updates through the list's existing scheduling idiom (not bare rAF→setState; [L05]).

**Hysteresis.** Mount at ±1 viewport, evict at ±2 viewports, and only after scroll settles (~300ms quiet). A row oscillating at the boundary never thrashes; flick-scrolls mount forward-margin rows in rAF-batched groups while departed rows wait for the settle.

**Settled rows only.** The in-flight turn's rows are never evicted (heights are still changing; streaming writes land there). Eviction begins at the same settled-entry boundary F-A(1)'s containment uses. Turn units per `tuglaws/turn-metric.md`.

**Pinned rows (I-4).** Never evicted while the condition holds: rows hosting keyboard focus or a descended editing scope (CM6 — `reference` behavior per the descend-scope contract); rows intersecting a non-collapsed DOM selection (conservative rule: any active selection in a card suspends that card's evictions — substrate responders read the DOM); rows carrying find highlights while find is open; rows hosting permission dialogs / control-bar overlays; the restore scroll-anchor row. Stateful embeds that keep in-DOM-only state (media, inner scrollers) pin their row — re-mount must be state-lossless or not happen ([L23], [L26]).

**Mount identity ([L26]).** Row identity is the stable row key; a re-mounted row reconstructs from the store and is logically the same row. Eviction/re-mount is a windowing lifecycle, not a logical transition — but it must be *observably* identical, which is what the pinning rules guarantee for every state class that lives only in DOM.

## The ledger {#ledger}

Per-card, in-memory `Map<rowKey, {height, widthEpoch, contentRev}>` owned by the transcript's list controller. **Not persisted** — no localStorage/IndexedDB (standing rule), no tugbank round-trip; heights are cheap to re-derive and staleness across launches is a bug class we simply refuse to have. A fresh launch rebuilds the ledger during the restore traversal.

**Write path.** The existing ResizeObserver stamp (the cv `contain-intrinsic-size` write) also records into the ledger — one measurement, two consumers. Measurement stays in observer callbacks, never inline after a parent-triggered child setState ([L04]).

**Invalidation axes:**

- **Width.** `TugListView` already wipes cv stamps on cell-width change (`tug-list-view.tsx` ~2228–2252: "`contain-intrinsic-size` is exact only for the width it was measured at"). The ledger shares that epoch. On a width change (pane resize), visible rows re-measure immediately (they are mounted anyway); far rows re-measure via the background sweep (below), and until a row is re-swept its previous-width height stands as *stale-but-real* — it was real pixels at the old width, it affects only offscreen geometry, and the scroll anchor (distance-from-bottom, per `session-restore-window.ts`) keeps the viewport stable while the sweep converges. This is the design's one honest compromise, and it is invisible by construction.
- **Font scale / page zoom.** Folded into the epoch key; a zoom change is a full-ledger epoch bump, same sweep.
- **Content revision.** A row model change (block expand/collapse, late tool result, annotation) bumps `contentRev`. Such changes happen on mounted rows by construction (they are user-driven or streaming-driven, both pinned classes), so the re-measure is the ordinary stamp on the already-mounted row.
- **Theme.** Not an axis — themes share one tone skeleton and metrics; a hue change moves no pixels. (If a future theme changes metrics, it must bump the epoch — noted here so the assumption is auditable.)

## Batch shapes {#batches}

- **Restore traversal.** Ingest builds row models as today. Mount the anchor window immediately (what restore visibly needs). Then a background sweep builds the ledger for the rest: batches of ~40 rows, one batch per idle slice — mount in place, stamp, evict. Peak transient DOM = window + one batch, which bounds the restore churn spike (measured today: ~550MB of dirty heap pages from an unbounded restore mount, reclaimable only by a critical purge) to batch-sized tens of MB.
- **Scroll re-mount.** Rows entering the forward margin mount in rAF-batched groups through the list's scheduler. A flick across a whale region mounts at most margin-plus-viewport worth of rows; not-yet-mounted rows show the blank placeholder — identical to today's cv-skipped cell mid-flick.
- **Idle eviction.** On scroll-settle, evict everything beyond the hysteresis margin in one batch.
- **Expand gesture.** Synchronous single-row (or single-block) mount in the click's commit. The worst case — a 250-block run expanded in one gesture — mounts ~7k nodes once, user-initiated, and immediately joins the cv regime so offscreen members stay paint-skipped.

## Verification {#verification}

Meters, in the program's standing discipline (lab gates diffs; the user's live instance is the only success surface):

- **Footprint:** `footprint <WebContent-pid>` steady-state target **< 700MB total** (WebKit malloc < 350MB, graphics < 300MB) on the loaded release deck; stretch < 500MB with F-A(3b) occlusion culling. Restore peak bounded (no ~550MB churn spike).
- **The train:** dual ledger (`diag/deck-probes/dual-arm.js`) on the live instance — zero 30s-metronomic pairs over a 5+ minute watch. `notifyutil -p org.WebKit.lowMemory` recovery pairs shrink to noise (< 50ms) since the cold re-resolve walks a viewport-sized document.
- **Typing:** at9996 typist cell at weight 500 — must not regress from q50=7/q90=16/q99=29; expected to *improve* toward the ~1ms floor since I6 mounted weight collapses.
- **New at9996 eviction cell:** heavy weight, assert mounted-node count ≤ budget while total row count is constant; scroll the transcript full-range and assert no visible-height discontinuities (the pixel-identity check, machine-verified).
- **App-tests (selective, `@covers`):** scroll fidelity far-up/far-down, find-reveal into an evicted region, expand/collapse round-trip, selection-pinning behavior, restore anchor landing. Reveal scrolls still clear the stuck-header bottom (standing gotcha).

## Law cross-references {#laws}

[L02] store-only external state (I-3) · [L04] measurement discipline (ledger write path) · [L05] no rAF for state-commit-dependent ops (batch scheduling) · [L13] rAF is not for animation (batching is scheduling, and must stay that) · [L22] observers drive DOM directly (mount tracking) · [L23] never destroy user-visible state (pinning, I-4) · [L24] state zones (mount set is view-zone) · [L26] mount identity across logical transitions (re-mount reconstruction contract) · [L19]/[L09] component boundaries (mechanism lives in TugListView; the transcript passes policy) · `tuglaws/turn-metric.md` (units) · standing rules: no height estimates (I-2), no localStorage (ledger is in-memory), no-resting-lies does not apply (no drafts involved) · `tuglaws/app-test-harness.md` (selection discipline for the new cells).

## Staging {#staging}

1. **E1** — row-level eviction in `TugListView` (new `evictOffscreen` mode riding the `offscreenSkip` machinery), transcript adopts it for settled rows; ledger + pinning + batches as above. This is the program's spine and the bulk of the win.
2. **F-A(3b)** — occlusion culling for cards stacked behind the front card in a pane (graphics-side; independent, can land before or after E1).
3. **E2** — intra-entry block-run eviction, only if E1's residual (visible whale entries) still bills meaningfully.
4. **Restore-churn cap** — the batched restore traversal, which E1's machinery gives nearly for free.
