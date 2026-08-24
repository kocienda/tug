# Scrolling memory diet — bounding graphics backing by the viewport, not the document {#top}

**Parted off from [aug01-perf-brief.md](aug01-perf-brief.md) §F-E on 2026-08-01.** That brief keeps the malloc/DOM program (E1 shipped, heap census, [P06] E1b gate). This brief owns the graphics term: the IOSurface backing-store bill for the deck's giant scrollable documents, and the program to bound it by what is on screen.

**The organizing complaint, verbatim in spirit:** there is no reason to ever hold backing store for ~70,000 pixels of card content. The model to aim at is UITableView's: the scroll position is a number, the content size is a number, and the pixels that exist are the pixels on screen (plus a small prefetch apron). A web document gets this wrong by default — WebKit backs composited scrolling content with tiles allocated by *layer area near the viewport*, not by *what the user can see* — and our transcripts are 50–78k px tall. The job is to make the web behave like the table view without giving up native-feel scrolling or a single frame of blank content.

**Two co-equal goals, neither sacrificed to the other:** (1) graphics dirty bounded and steady — no term that scales with document length; (2) user-visible scrolling excellence — native wheel feel, no blank tiles under flicks, no FOUC, no flash-of-blank-card, not even for one frame. A cut that saves memory by showing checkerboard is not a cut; it is a regression with a smaller footprint.

## Evidence (2026-08-01, live release deck, causal probes) {#evidence}

- At dpr=2, every CSS pixel of composited backing costs 16 bytes. The deck holds three transcript scrollers at 770 × 52–78k px (592–872MB *full* backing each) and two CM6 editors at ~800 × 11.6–13.7k px (~150–175MB each). Window is 2879×1599.
- `vmmap` names the graphics term precisely: the single **"owned unmapped memory"** region — the IOSurface pool — **306–746MB dirty across the 30s monitor cycle** at probe time (peaks to ~1.2GB observed earlier the same evening), against WebKit malloc steady at ~299–312MB post-E1.
- **Causal probe A (occlusion):** `visibility: hidden` on the three fully-occluded middle-column panes dropped the graphics trough **589 → 356MB**. ~230MB of the bill is tile backing for cards nobody can see. Reverted; invisible to the user throughout — which is itself the feasibility demonstration for occlusion culling.
- **Causal probe B (overlays):** hiding both full-window `position: fixed` overlays (`tug-banner-scrim`, `tug-canvas-overlay-root`) moved nothing. The transparent-overlay hypothesis is **refuted**; do not resurrect it.
- **The residual churn:** with the occluded panes hidden, graphics dirty still climbed ~200MB per 30s cycle — the *visible* cards' tile coverage re-materializing after each purge. The 30s purge train (aug01 brief §S9) is at this point substantially a graphics-tile cycle: volatilize, repaint, repeat.
- **An honest anomaly to resolve, not bury:** pre-E1 graphics-dirty snapshots read ~518–535MB; post-E1 the oscillation peaks read *higher*. Candidate explanations: pre-E1 reads landed on troughs; or eviction's mount/unmount at the window edge re-dirties tiles every scroll and every 30s re-materialization repaints more than before. **Resolved by the G2 first pass ([#g2-first-pass]): trough-vs-peak sampling — eviction's purge floors are flat and identical to the full-inline arm's, no re-dirty penalty exists.**
- **2026-08-01 evening, unforced live baseline (deck in active use):** graphics dirty 565–977MB across 12 samples at 5s (floor ~565, spikes while cards were being raised); malloc steady 265–299MB. Visible scroller geometry at the same moment: transcripts 78,320 / 55,970 / 2,694px (all `data-evict-active`), a buried 14,564px CM editor and a buried 3,744px one — ~1.9GB if backing followed content length.
- **Instrument rule, learned the hard way: tile numbers from a hidden window are not coverage numbers.** A buried/backgrounded page's backing is dropped by policy; the G2 cell hard-fails on `visibilityState !== "visible"`.

## How WebKit bills this memory (mechanics primer for cold readers) {#mechanics}

A wheel-scrollable `overflow` area on macOS WebKit is promoted to **composited async scrolling**: the scrolled contents become their own compositing layer so the scroll thread can move them without waiting on the main thread. That layer's size is the *content* size — 770 × 70,731 for a transcript — and WebKit backs it with **tiles** (IOSurfaces) covering the viewport plus a speculative margin that grows with scrollability and recent velocity. Tiles outside the visible rect are marked **volatile** (purgeable — the 0.9–1.3GB "Reclaimable" column in `footprint`); the 30s memory monitor purges them under pressure; ongoing paint re-materializes them. Two consequences frame everything below: the bill is a function of **layer area near the viewport**, not painted complexity — a tile over blank spacer costs the same bytes as a tile over dense prose, *unless* WebKit's solid-color-tile optimization replaces it with a color quad; and E1 could not touch this **by design** — pixel identity preserves `scrollHeight`, so the layer area is unchanged even though the DOM inside it is now viewport-sized.

## Doctrine (carried from the S9 program, binding here) {#doctrine}

- **Measure before cutting.** Every work item below either *is* a measurement or cites one for its expected value. No estimated-MB claims survive contact with a probe (the overlay refutation is the standing example).
- **The live release deck is the only success surface.** Lab cells gate diffs; they never declare victory.
- **Pixel identity and motion designs are FIXED.** No visible-surface change may be proposed as a memory fix. Scroll feel is user-visible surface.
- **No FOUC, no blank flash, not even one frame.** Any mechanism that reveals previously-suspended content must land its reveal in the same commit as the gesture that exposes it, and the lab asserts it.
- Only the user commits on `main`.

## Work items {#work-items}

### G1 — occlusion culling: suspend fully-buried panes {#g1-occlusion-culling}

**Measured worth ~230MB at today's stacking (probe A); grows with stack depth; the buried-CM-editor case is the expensive one.** A pane fully occluded by opaque panes above it gets `visibility: hidden`; geometry, layout, scroll positions, CM state, eviction ledgers, and running animations are all preserved (visibility invalidates paint only). On raise, the visibility flip lands **in the same commit as the z-order change** — the compositor does not present the frame until the newly-visible tiles are painted, so the user sees nothing, then the finished card; the cost is one screenful of tile paint (~10–50ms, a frame or two at 120Hz) folded into the raise. Design obligations: an honest full-occlusion test (opaque coverage, not rect intersection alone); un-hide on every path that can expose a buried pane (raise, close/removal of a covering card, drag of a covering card, deck restore, resize); and a lab cell that drives raise-from-buried and asserts both the raise-frame budget and zero blank-frame (screenshot the raise frame; no background-colored band where card content belongs). Laws: [L06] (visibility is a DOM write, never React state), [L22] (occlusion observed from geometry the deck already owns), [L23] (nothing torn down).

#### G1 build, 2026-08-02 — controller landed, lab green, live read pending relaunch {#g1-build}

**The mechanism.** `pane-occlusion-controller.ts` (chrome/) is the sole authority for `data-occluded` on `.tug-pane` frames, the exact `pane-focus-controller` idiom: store snapshot → `useLayoutEffect` post-commit DOM write, so a reveal always shares the paint with the commit that rendered the new z-order. Timing is asymmetric by design: **reveals are synchronous** (raise, close, restore, resize, imposition — all reach the pass through the store snapshot in the same commit), **hides are lazy** (400ms settle debounce, re-deferred while any pane frame reports `getAnimations().length > 0`, so a pane is never hidden while its coverer is mid-FLIP or mid-collapse-transition). Geometry is `offset*` — untransformed layout — so a FLIP's inverse transform never pollutes the decision; z is read back from the frame's inline `z-index`. Appearance-zone gestures (drag, resize, Lens resize) move frames with no store commits, so the three gesture machines in `tug-pane.tsx` bracket their move-latch → pointer-up with `paneOcclusionGesture.begin()/end()` — begin reveals everything before the first moved paint, end re-arms the settle pass. The CSS is a subtree rule (`.tug-pane[data-occluded="true"], … *` with `!important`), not a frame rule: `visibility` inherits, but descendants that set `visibility: visible` explicitly (the jump-to-bottom button, hover-revealed row controls) beat inheritance and would paint alone above a hidden pane.

**The predicate, honestly conservative.** A coverer counts only when its chrome's computed background alpha is 1 and frame+chrome `opacity` are 1; corners are honest (a covered corner either coincides with the coverer's corner — aligned rounding masks — or clears the coverer's radius inset); single-coverer containment only, no union coverage; the active pane is never hidden (it may hold browser focus). Anything unprovable stays visible. Two build lessons, both caught by the cell: (1) WebKit computes theme backgrounds as `oklch(…)` — an rgb-only alpha parser reads "not opaque" and never hides anything; the parser now handles the CSS color functions generally and still fails closed on unknown forms. (2) A coverer's own `data-occluded` must NOT disqualify it (pane-chrome visibility is only ever hidden by this controller, and containment is transitive) — with the naive visibility gate, the raise pass computed the demoted pane's cover against the not-yet-revealed raiser and never re-armed the hide timer.

**Lab: at0332, 2/2 green.** Background cell: hides settle at rest on the 3-stack (buried two stamped, top + disjoint pane untouched); raise-from-buried reveals **in the same eval that commits the raise** (mutate-then-read, no awaits — the flip rides `transferFocusForActivation`'s `flushSync`); the demoted former top is NOT hidden in the raise commit (lazy hides) and settles hidden after; close of the coverer has the buried pane revealed by the moment the pane count drops; a restore that offsets the top pane clears the newly-peeking pane's hide in the seed commit while correctly KEEPING the still-covered bottom pane hidden. Foreground cell: `nativeDragWithoutRelease` on the coverer's title bar → mid-gesture every pane visible, re-settle after drop; raise-then-screenshot shows real content in the pane interior (no background-colored band), **raise-to-presented ≈ 186ms by double-rAF bracket through the harness** (the assert holds < 250ms; the in-page cost is far smaller — the bracket includes eval RPC overhead). Surface 1.19.0 adds `__tug.activateCard` (the REAL raise: `store.activateCard` inside `transferFocusForActivation` — `DeckManager.activateCard` alone flips the responder and leaves the pane buried, a trap now written down).

**Accepted paint delta.** A hidden pane's drop shadow paints outside the covered rect, so stacked identical shadows lose the buried panes' contributions (a slightly lighter ring). Probe A ran exactly this on the live deck and the user judged it invisible; recorded here, not silently.

**Live read, 2026-08-02 (post-relaunch, WebContent 69497, 5s cadence, unforced, deck in active use): G1 delivers.** Mechanism confirmed live from the drop: exactly the two predicted panes stamped `data-occluded="true"` (x=5 column z2 under z5; x=810 column z1 under z6), tops/Lens/disjoint untouched. Cross-relaunch: culled floor **~402M** (troughs 401.8–404 over 4.5 min) against the pre-G1 **472.8M** floor — but a relaunch confounds this (malloc also moved 366 → 265–315M, a lighter restored state), so the number that counts is the **same-instance causal A/B**: holding both stamps stripped (re-stripped every 2s — one strip self-heals, any store notify re-runs the pass and re-stamps within seconds on an active deck) the floor sat at **526–529M** after a ~746M materialization spike; restoring the stamps brought it back to **396–419M**. Causal delta **~110–125MB for two buried panes ≈ 55–63MB/pane** — below the ~78MB/pane prediction carried from probe A's 3-pane average (per-pane cost varies with what is buried; probe A's set included heavier content), same order, and the two-pane arrangement was never going to reproduce the 3-pane 233MB. Verdict: shipped, invisible, and worth **~110–125MB at today's stacking plus those panes' share of the 30s repaint churn**; the win scales with stack depth as designed.

### G2 — the tile ledger: size per-layer coverage and the re-dirty cycle {#g2-tile-ledger}

**The instrument the rest of the program sequences on.** A repeatable read that attributes graphics dirty per scroller, in the lab where cards can be hidden freely: the at9996 machinery seeds a heavy transcript, and an `owned unmapped memory` sampler (vmmap, 5s cadence) reads deltas while the cell (a) parks at rest, (b) scrolls at controlled velocity, (c) sits through three 30s purge cycles, (d) toggles eviction on/off (`evictOffscreen` is a prop — the A/B is free). Questions it must answer with numbers: how many viewports of tile coverage does WebKit actually keep per scroller at rest and under flick; does eviction's window churn re-dirty more tile area per cycle than the pre-E1 static DOM did (the §evidence anomaly); what share of the visible-card churn belongs to the transcripts vs the front CM editor. Output: a table in this brief, and the go/no-go facts for G3–G5.

#### G2 first pass, 2026-08-01 — the rig, two lab runs, and the live corroboration {#g2-first-pass}

**The rig exists and runs end to end.** The `AT9996_TILES=1` cell in at9996 seeds a 300-row transcript, samples `vmmap --summary` **host-side from the test process** (host reads never touch the one-at-a-time harness RPC channel, so they overlap scroll driving as async spawns), and runs baseline → rest → 3× forced-purge → constant-velocity sweep, once per arm. The A/B arm is real: `window.__tug.setTranscriptEvictionDisabled(true)` (test-surface 1.18.0) flips a lab-flags store the transcript reads via `useSyncExternalStore`, so the same rows re-render full-inline at the same layer height with no relaunch. WebContent pid found by set-difference of `pgrep -f com.apple.WebKit.WebContent` across the launch (WebContent is launchd-parented; parentage can't identify it, arrival can).

**Lab numbers (both runs, ~150-turn/300-row transcript, 786×880 scroller viewport, dpr 2):**

| phase | eviction ON | eviction OFF (full inline) |
|---|---|---|
| rest, parked mid-document | 127–157MB, flat floor **126.9–130** | 133–143MB, flat floor **133–141** |
| forced purge ×3 | blip to ~228–233, back to the **same** floor each cycle | blip to ~236–244, same floor each cycle |
| constant-velocity sweep | mean 187–199, max 225–240 | mean 196, max ~205 |
| WebKit malloc during the arm | **~209MB** | **~336–540MB** |
| empty-deck baseline | mean 99–139, min 48 | — |

**VALID VISIBLE-WINDOW PASS (2026-08-01, later the same evening, `visibility: "visible"` / `focused: true` at every snapshot, window held forward by a 3s `osascript activate` loop for the whole run; at9996 2/2 green).** Same 300-row transcript, 786×880 scroller, dpr 2. Evicted `scrollHeight` 70,286 vs full-inline 72,582 — the arms finally describe the same document.

| phase | eviction ON | eviction OFF (full inline) |
|---|---|---|
| empty-deck baseline (chrome floor) | mean **97** (min 48, max 196) | — |
| rest, parked mid-document | mean **146** (130–149) | mean **149** (148–157) |
| forced purge ×3 | mean **152** (128–217) | mean **151** (128–217) |
| constant-velocity sweep | mean **254** (166–291) | mean **256** (193–281) |
| WebKit malloc during the arm | ~209MB | ~336–540MB |

**Q1 — how many viewports of tile coverage per scroller.** One viewport of this scroller is 786×880 = 692k CSS px = **11.1MB** at 16 B/px. Transcript-attributable graphics at rest = 146 − 97 = **~49MB ≈ 4.4 viewports**; against the truer empty-deck floor of 48MB it is ~98MB ≈ 8.8 viewports. Under sustained scrolling: 254 − 97 = 157MB ≈ **14 viewports**, recovering to the rest floor afterward. So WebKit keeps **roughly 4–9 screenfuls of backing for one screenful of visible transcript at rest, and transiently 14+ while scrolling** — bounded (no document-length term) but far from frugal.

**Q2 — does eviction re-dirty more? No, definitively.** Rest 146 vs 149, purge 152 vs 151, scroll 254 vs 256 — indistinguishable in every phase, with flat purge floors and no ratchet across three cycles in either arm. The §evidence anomaly was trough-vs-peak sampling. E1's malloc win reproduces (209 vs 336–540MB) while graphics is untouched, exactly as designed.

**Q3 — transcript vs editor share: still open.** The lab deck's editors are one-line prompt entries, not the live deck's 11.6k/13.7k px documents. Needs a lab variant with a heavy editor, or a live decomposition when the deck is not in use.

**This reopens G4 and reframes the program:** 4–9 viewports at rest is *tile policy*, not our DOM — no application-side change can touch it, and bringing it toward ~2 viewports would be worth roughly 25–75MB per visible scroller. G3 stays closed (no length-proportional spacer bill exists to zero out).

**The earlier hidden-window pass, kept for the lesson.** `document.visibilityState` read `"hidden"` at every geometry snapshot: the user was at the machine both runs, and the foreground lab window was buried immediately. A hidden window's tile backing is dropped/minimized by policy, so these numbers measure WebKit's *hidden-window* policy, not visible-window coverage. Two secondary findings from the same trap, both real: (1) **rows measured while the page is hidden stamp short** (~90px vs ~242px true — cv-skipped layout feeding the eviction ledger; post-seed evicted `scrollHeight` read 26,964–51,215px against 72,582px full-inline), a live watch-item for streaming-while-backgrounded sessions; (2) the cell now hard-fails on a non-visible window and warm-sweeps every row in half-viewport steps before the arms, so the next idle-machine run is valid by construction. Forced purges via `notifyutil` are Darwin-global — a lab run makes every WebContent on the machine purge once, including the live deck's; each just repaints as it already does on the 30s clock.

**What survives the hidden-window caveat, and what the live deck adds:**

- **No document-length term, twice over.** Within the lab, a 72,582px layer and a ~27k px layer cost the same graphics dirty at rest, both ≈ the empty-deck floor. And on the **visible live deck**, today's steady evidence says the same thing at full scale: visible scrollers total ~137k px of content (78,320 + 55,970 + 2,694 transcripts, plus a 14,564px buried CM editor) = **~1.9GB if backing followed content length**; the observed visible-cards-only trough (probe A, buried panes hidden) was **356MB**, and today's unforced band with everything visible is 565–977MB. Coverage is viewport-scale, not length-scale, in both environments.
- **Q2 answered: eviction does not re-dirty more tile area than the static DOM.** Purge floors are identical and flat across cycles in both arms; no ratchet, no climb. The §evidence anomaly (post-E1 peaks reading above pre-E1 snapshots) is attributed to trough-vs-peak sampling of an oscillating term, not to eviction churn.
- **E1's malloc win reproduced in captivity:** ~209MB evicted vs ~336–540MB full-inline for the same 300 rows.
- **Scroll adds a bounded transient** (~+60–75MB over the rest floor) in both arms, recovering at rest.

**Q1 (viewports of coverage, visible window) and Q3 (transcript vs editor share of visible churn) remain open** pending a run with the lab window actually visible — the rig is ready; it needs the machine free. Q3's live decomposition by hiding *visible* cards was deliberately not run: the deck was in active use, and flashing the user's working cards to measure them is not a probe, it is a disruption.

**Consequences for the program (go/no-go):**

- **The bill is not per-scroller coverage.** Live floor ≈ 356–565MB against a ~1.9GB length-scaled potential means WebKit is already UITableView-frugal about *how much of each document* it backs. The graphics term is **layer breadth × window area, plus the 30s re-materialization churn of visible cards (~200MB/cycle)** — many composited planes (panes, editors, chrome, overlays) each holding a viewport-scale backing, re-painted every purge cycle.
- **G3 (solid tiles): closed.** There is no length-proportional spacer bill to zero out at rest.
- **G4 (WKWebView tile-policy knobs): PROMOTED by the visible-window pass.** 4–9 viewports of retained coverage per scroller at rest is tile policy, unreachable from application code; a coverage-margin control that brought it toward ~2 viewports is worth ~25–75MB per visible scroller. This is now the second item after G1.
- **G5 (viewport canvas): entry bar not met.** Coverage is bounded and length-independent; rebuilding scroll ownership does not address layer breadth or the re-materialization churn, which is where the live bill actually sits.
- **G1 (occlusion culling): unchanged — the single biggest measured lever (~230MB)**, and after this pass it is most of the known headroom. G6 (visible-editor share) gets priced by the visible-window pass.

### G3 — solid-tile verification: are we paying for blank pixels? {#g3-solid-tiles}

Under E1, everything beyond ±1 viewport of a transcript is spacer — uniform background, zero content. WebKit can represent a tile that is a single solid color as a color quad with **no IOSurface at all**. If that optimization is firing, far-coverage tiles are already free and the bill is genuinely near-viewport; if it is not (a background that isn't uniform under the spacer, a border, a non-opaque scroller background, or the optimization not applying to this layer type), we are paying 16 bytes/px for *blank* regions — the cheapest possible fix would be making the spacer regions provably solid. G2's rig answers this directly: park the window so coverage extends deep into spacer, read whether dirty tracks coverage area or mounted area. If solid tiles are not firing, find the paint that breaks uniformity and remove it (this is invisible-by-definition work: the region is blank either way).

### G4 — WKWebView tile-policy reconnaissance (Tug.app side) {#g4-wkwebview-knobs}

Tug.app owns the WKWebView; WebKit's tile behavior has host-side switches whose availability and default state must be **verified against the macOS 15 SDK/SPI, not assumed**. Candidates to check, each validated by a G2 lab A/B: aggressive tile retention (must be OFF — it retains *more*), temporary tile-cohort retention (retains just-scrolled-past tiles for a grace period; turning it off trades a little re-paint for steady-state memory), giant-tile mode, and any coverage-margin control reachable through `WKPreferences`/`_WKProcessPoolConfiguration`. Honest framing: this item is reconnaissance with a validation harness, not a promised fix — if no reachable knob changes G2's numbers, write that verdict here and move on. Interaction to respect: the 30s monitor already volatilizes coverage under pressure; a knob that merely shrinks *reclaimable* without shrinking *dirty-between-purges* is worth nothing to this program.

#### G4 recon, 2026-08-02 — runtime-verified inventory (macOS 15.6, 24G84) {#g4-recon}

**Method: objc runtime introspection against the installed WebKit, not header folklore** — `class_copyMethodList` on `WKPreferences`/`WKWebViewConfiguration`/`WKProcessPool`/`_WKProcessPoolConfiguration`/`WKWebView`, plus enumeration of the `_features` list (544 entries), with a live smoke test of the setter path. Config point in tugapp: `MainWindow.swift:402–412` builds the `WKWebViewConfiguration` and already uses KVC (`developerExtrasEnabled`), so no private headers are needed.

**The setter path is verified working.** `WKPreferences` exposes `_setEnabled:forFeature:` / `_isEnabledForFeature:`; a smoke test flipped `TemporaryTileCohortRetentionEnabled` to false on a real instance and read it back. Any of the 544 feature keys is reachable by name at config time.

**Candidates for the G2 A/B, in order:**

1. **`TemporaryTileCohortRetentionEnabled` = false** (default true; no direct selector, feature-key path verified). The cohort is the grace period holding just-scrolled-past tiles; expected effect is trimming the post-flick transient (G2 measured ~14 viewports under flick recovering to 4.4 at rest) more than the rest floor itself. Cheap to test, plausibly free of visible cost.
2. **`ScrollingPerformanceTestingEnabled` = true** (default false). Folklore says WebKit clamps tile coverage toward the visible rect under this flag so scroll benchmarks are deterministic — **unverified semantics; the rig is the arbiter.** If it does clamp, it attacks the 4.4-viewport rest margin directly — but checkerboard-under-flick risk is first-order, and the scrolling-excellence goal gates it: any blank tile under a flick disqualifies it regardless of the MB.
3. **`UseGiantTiles`** (default false; direct selector `_setUseGiantTiles:`). Larger tile granularity likely *worsens* overdraw at our geometry; A/B only because it is nearly free to run.

**Guard:** `AggressiveTileRetentionEnabled` defaults **false** and must stay false — it retains more, and enabling it is the one clearly wrong direction.

**Verified negative:** no coverage-margin multiplier, speculative-paint distance, or backing-store budget control exists anywhere in the feature set or the SPI selector surface on this OS (swept for tile/coverage/margin/speculative/prefetch/backing/volatile/purge/retention). The 4.4-viewports-at-rest margin is hardcoded velocity-driven policy in `TileController`; if candidates 1–2 do not move G2's numbers, that is G4's exit verdict and the remaining levers are layer breadth (G1, already shipped) and G5.

**Instruments gained for the rig:** `TiledScrollingIndicatorVisible` (draws WebKit's own tile grid + coverage rect — turns the coverage question from vmmap inference into direct observation) and `CompositingBordersVisible` / `CompositingRepaintCountersVisible` for the layer census. `_WKProcessPoolConfiguration.suspendsWebProcessesAggressivelyOnMemoryPressure` exists but concerns background process suspension, not tiles — irrelevant here.

**Next step:** an env-gated feature block in `MainWindow.swift` (e.g. `TUG_WK_FEATURES="TemporaryTileCohortRetentionEnabled=0"`) so the G2 rig can A/B each candidate per app-test launch without touching release behavior; release adopts a knob only after the rig shows a win with zero scroll-fidelity cost.

#### G4 A/B, 2026-08-02 — hook landed, first two arms run, campaign paused {#g4-ab}

**The hook is in:** `applyWebKitFeatureOverrides` in `MainWindow.swift` (uncommitted) parses `TUG_WK_FEATURES="Key=0,Key2=1"` and applies each key via the verified `_setEnabled:forFeature:` path at configuration time; absent the variable it is a no-op, so release behavior is untouched. The app-test harness forwards every `TUG*` variable automatically, and application is verifiable in the launch log (`tests/app-test/logs/at9996-tiles.log` shows `TUG_WK_FEATURES: TemporaryTileCohortRetentionEnabled = 0`).

**Methodology note, binding:** the first two arms were run with a 3s `osascript activate` keeper loop holding the lab window forward while the user worked — **that technique is banned, never again for any test** (it steals the user's keyboard). The remaining arms ran on a genuinely idle machine (user away), where a single normal launch stays visible with no reactivation; that is the sanctioned pattern. If idle-machine windows become scarce, the harness alternative is a front-ordered non-key lab window (`orderFrontRegardless()` + floating level — `visibilityState` is occlusion, not focus), at the cost of covering the user's screen; not built.

**The campaign (at9996 tiles cell, 150 turns, 786×880 scroller, dpr 2, one full run per arm; graphics dirty MB, mean with min–max, evict sub-arm shown — the full-inline sub-arm tracked it within noise everywhere):**

| arm | rest | forced purge ×3 | constant-velocity sweep |
|---|---|---|---|
| control (no overrides) | 143 (126–149) | 159 (133–209) | 284 (176–325) |
| **cohort retention OFF, run 1** | 151 (130–181) | 151 (128–225) | **217 (147–233)** |
| **cohort retention OFF, run 2** | 149 (149–149) | 150 (128–223) | **215 (147–233)** |
| ScrollingPerformanceTestingEnabled | 148 (145–149) | 148 (122–216) | 262 (162–288) |
| UseGiantTiles | 285 (241–291) | 291 (239–387) | 502 (289–590) |

**Verdicts:**

- **`TemporaryTileCohortRetentionEnabled=0` — ADOPT (proposed).** Reproducible across two independent runs: sweep mean −67/−69MB and max −92MB vs control, rest and purge floors unchanged (the cohort is the just-scrolled-past grace period, not rest coverage — exactly as predicted). All cell assertions green in both runs. The mechanism trades a briefly-held dead tile for an earlier repaint if the user reverses scroll direction — the one felt-risk to check live.
- **`ScrollingPerformanceTestingEnabled` — REJECT.** The folklore coverage-clamp does not materialize on macOS 15.6: rest floor 148 vs control 143 (no clamp), and its transient trim (262) is far weaker than cohort-off's (217). A testing flag with unaudited side effects buys nothing cohort-off doesn't buy better; no combination arm is justified.
- **`UseGiantTiles` — REJECT, emphatically.** Doubles the rest floor (285 vs 143) and nearly doubles the sweep (502 vs 284) — larger tile granularity forces backing for pixels the small grid never materialized. Closed forever.
- **The rest floor is confirmed unreachable.** No exposed knob touches the 4.4-viewports-at-rest coverage (the recon's verified negative, now corroborated causally by the one candidate that claimed otherwise). **G4 cannot deliver the −136MB rest-floor projection in [#sequencing]; that headroom belongs to G5 or stays unclaimed.**

**Adoption shape (implemented in the working tree, the user lands it):** `defaultWebKitFeatureSpec = "TemporaryTileCohortRetentionEnabled=0"` in `MainWindow.swift`, applied at configuration time; a `TUG_WK_FEATURES` env spec replaces the default wholesale, so `TemporaryTileCohortRetentionEnabled=1` restores stock WebKit for a control arm. Gate before landing: one live felt-scroll pass on the user's release deck (relaunch with `TUG_WK_FEATURES=TemporaryTileCohortRetentionEnabled=0` exported, flick and direction-reverse the heavy transcripts) — if no blank tile is ever felt, bake the default; if one is, the knob stays lab-only and G4 closes with the transient win unadopted. Expected live effect: the flick-transient band (G2 measured ~14 viewports under flick) tightens toward the rest floor, and the 30s churn's scroll-driven component shrinks; the steady floor does not move.

### G5 — the endgame: a viewport-sized scroll canvas (only if G2–G4 fail to bound the term) {#g5-viewport-canvas}

The structural fix, held in reserve because it is the expensive one: stop giving WebKit a 70k px layer at all. The scroller's real content becomes O(viewport) tall; scroll position is virtualized (the number the spacers currently encode becomes explicit state); mounted rows are placed by transform inside a viewport-sized canvas. This is how VS Code's editor and every native table view already work — backing store is bounded by the screen *by construction*, and no tile policy can change that. It is also a deep cut against things we currently get for free: native scrollbar and wheel/momentum feel (SmartScroll and [D07] are built on real `scrollTop`), find-in-page reveal, `scrollIntoView`, the restore-anchor protocol, and E1's own geometry. E1's measured-height ledger and windowing math carry over intact — what changes is who owns the scroll offset. **Bar to enter:** G2 shows tile coverage cannot be brought under ~2 viewports per visible scroller by G3+G4, or the re-dirty cycle cannot be broken. If entered, it gets its own design doc and recipe (devise → vet → implement), with scroll-feel parity as a machine-checked acceptance criterion (velocity/settle traces A/B'd against native), not a hope.

### G6 — the CM6 editors: same disease, editor-shaped {#g6-cm6-editors}

The two buried editors are G1's problem while buried, but a *visible* 13.7k px editor still carries a content-height scroll layer with a full-height sticky gutter (47 × 13,664). CM6 already windows its DOM (it draws ~viewport lines); the layer area is what bills. Sequenced behind G2 (which prices the visible-editor share) and G3/G4 (which may fix it for free); if the editors remain a standing term after those, the CM-specific options (gutter treatment, CM's own `contentHeight` handling) get their own item with numbers.

#### G6 priced and CLOSED, 2026-08-02 — a visible heavy CM6 editor costs ~29MB (~2 viewports), no CM-specific work warranted {#g6-priced}

**The instrument:** new `AT9996_EDITOR_TILES=1` cell in at9996 — a Text card bound to a real 4,998-line source file (`tug-list-view.tsx`, CM6 `scrollHeight` **100,144px** at 786×1105 / dpr 2 after a warm sweep), measured probe-A style in one instance: rest + forced-purge floors with the editor visible, the same deck with the pane `visibility: hidden`, then revealed. Run on an idle machine, single foreground launch, no activation loop; window visible throughout. (The run carried the new cohort-off default — irrelevant to rest floors, which cohort retention provably does not touch.)

| phase | graphics dirty MB (mean, min–max) |
|---|---|
| rest, editor visible | **77** (76–78, flat) |
| purge ×3, visible | 81 (69–146) |
| rest, editor hidden | **48** (48–48, flat — exactly G2's empty-deck chrome floor) |
| purge ×3, hidden | 53 (48–96) |
| rest, revealed again | 75 (flat) |

**The verdict: a visible heavy CM6 editor bills ~29MB at rest (77 − 48), ≈ 2.1 viewports (786×1105 = 13.9MB/viewport) — half the transcript's 4.4-viewport multiplier — and the cost is length-independent (a 100k-px document, 7× the live deck's biggest editor, still lands at ~2 viewports).** The likely mechanism: CM6's windowed DOM leaves everything outside the drawn window as blank layer area, and WebKit's solid-color-tile optimization (G3's subject) makes those tiles nearly free — the editor's far coverage is blank in a way the transcript's (real content under E1's exact-height placeholders? no — spacer is blank too; the difference is plausibly the gutter/content split) is not fully. Whatever the mechanism, the bill is small and bounded. Live implication: the deck's big editors are buried most of the time (G1 zeroes them); a *raised* one costs ~30MB while it is front. **No CM-specific engineering (gutter treatment, contentHeight interventions) can be justified against a ~30MB bounded, length-independent term — G6 is closed with a number, and G2's Q3 is answered: the visible-card churn belongs overwhelmingly to the transcripts.**

## Sequencing {#sequencing}

G2 first (the instrument), G1 in parallel (independently justified by probe A, already causally demonstrated safe). Then G3 (cheapest possible structural win) → G4 (host-side knobs) → decision point: if graphics dirty on the live deck is bounded and the train is gone, close; else G5. G6 rides the G2 numbers throughout. The malloc-side program (heap census, E1b) continues separately in [aug01-perf-brief.md](aug01-perf-brief.md) §F-E.

**Status after G2 (2026-08-01, [#g2-first-pass], visible-window pass complete for Q1/Q2):** G3 closed, G5's bar not met, **G4 promoted to co-lead**.

**Status after the G1 live read (2026-08-02, [#g1-build]):** G1 **shipped and measured live** — culled floor ~400–420M at a two-buried-pane arrangement, causal A/B −110–125MB (~55–63MB/pane; the working-order projection below assumed probe A's 3-pane stacking, so read its "565 → ~356" as arrangement-dependent). **G4 is now the front item.**

**Status after the G4 A/B campaign (2026-08-02, [#g4-ab]):** one knob adoptable — **cohort retention off** (sweep transient −67MB mean / −92MB max, reproduced; rest untouched) — pending a live felt-scroll gate. **The 4.4-viewport rest floor is verified unreachable by any exposed knob**, so item 2's "206 → 70MB" projection below is **refuted**: the rest-floor headroom (~136MB) now belongs to G5's entry decision, and the near-term program is the live coverage read (item 3), the layer census (item 4), and G6.

**Status after the G6 pricing (2026-08-02, [#g6-priced]):** **G6 closed** — a visible heavy CM6 editor bills ~29MB (~2.1 viewports), length-independent; buried ones are G1's. Item 5 below is done; Q3 is answered (the visible churn is the transcripts'). Remaining open items: the live per-scroller coverage read (item 3), the layer census (item 4), and the G5 entry decision — which now weighs deep surgery against a program whose felt problem (the sub-1.27GB purge train) is currently absent.

**The live floor decomposes, and that sets the order.** Applying G2's measured 4.4 viewports-at-rest to live geometry (transcript scrollport 798×1222 = **15.6MB/viewport**; window 2879×1599 = **73.7MB**):

| term | MB |
|---|---|
| root full-window plane | 73.7 |
| 3 visible transcripts @ 4.4 viewports | 206.0 |
| **subtotal** | **279.7** |
| measured visible-cards floor (probe A, buried panes hidden) | ~356 |
| unexplained residual (lens, pane chrome, small editor scrollers, overlays) | ~76 |

So **~79% of the visible floor is the root plane plus transcript tile coverage** — the layer census is chasing the remaining ~76MB and demotes to a verification step. And the same tiles are what the 30s monitor purges and repaints, so **the ~200MB/cycle churn is not a separate item: it is these tiles re-materializing.** Shrink the tiles and the floor and the swing fall together.

**Working order:**

1. **G1 — occlusion culling.** ~230MB measured, causally demonstrated, invisible when probed. Takes the live floor 565 → ~356. Also removes those panes' tiles from the purge/repaint cycle.
2. **G4 — tile coverage margin.** The 4.4 viewports is WebKit policy, unreachable from app code. 4.4 → 1.5 across three transcripts is **206 → 70MB (−136)**, and cuts the churn by the same proportion. Recon first (macOS 15 SDK/SPI, verified not assumed), validated by the G2 rig, which now exists and works.
3. **Live per-scroller coverage read** — confirm the 4.4-viewport figure at live geometry (lab scrollport was 786×880, live is 798×1222; if the margin is an absolute px band rather than a viewport multiple, the multiplier differs). Cheap: probe-A technique, one transcript hidden at a time.
4. **Layer census** for the ~76MB residual.
5. **G6 — editors**, priced by a lab variant carrying a heavy CM6 document (G2's Q3, still open).

**Projected exit:** G1 + G4 put the floor near **144MB + ~76MB residual ≈ 220MB** — under the ~300MB target, with the churn cut proportionally. That is roughly **three screenfuls**, against one screenful of actual pixels; the last stretch to ~150MB is the census and G6.

## Exit criteria {#exit}

- [ ] Graphics ("owned unmapped memory") dirty on the live release deck: **steady under ~300MB, no term that scales with transcript or document length**, no 30s re-materialization cycle — unforced, no `notifyutil` nudges.
- [ ] Total WebContent footprint unforced steady **< 700MB** (the S9 program's number, now jointly owned by this brief and the malloc program), purge train absent over a 10-minute dual-ledger watch.
- [ ] Scrolling verdict: lab scroll-fidelity cells (at0330, at9996 eviction + typist) green, G1's raise-frame/no-blank-frame assertion green, and the user's felt scrolling on the live deck reported excellent — all three, not any one.
- [ ] Every G-item above carries either a measured result or a written refutation; nothing left as an unpriced estimate.
