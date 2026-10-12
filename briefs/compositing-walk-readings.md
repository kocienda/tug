<!-- brief-skeleton v1 -->

# The compositing walk, read on the release deck

**Purpose:** Record what `tugtool deck motion walk` read on the user's release deck: how much the compositing walk costs a frame that carries a style change, how much of it the Overview, a parked workspace and a Session transcript account for, and whether `content-visibility: auto` takes a row out of the walk. These numbers answer the open questions of `briefs/compositing-walk-and-overview-brief.md`, and its Overview decisions follow from them.

---

## Purpose {#purpose}

`briefs/compositing-walk-and-overview-brief.md` left four questions to measurement: which population term prices the walk ([F03]), whether skipping unseen rows takes them out of it ([B02]), whether a parked workspace pays into it ([F06]), and what the Overview's stacking contexts and sticky elements are ([F04]). That brief decided the Overview skip would be built only if the reading showed it moving the walk, and that the Overview's row count would go to the user with these numbers in hand. This document is that reading.

---

## The reading {#the-reading}

- **Deck:** `release-main`, build `tugtool 0.8.15 (89e9bfa27)`, 2026-10-02, window in front (`visibilityState: visible` on every run).
- **Commands:** `tugtool deck motion walk --instance release-main --rounds 5 --frames 60 --json`, then the same with `--driver transform`. Both exited 0: each closing `restore` found nothing (0 writes replayed, 0 marks, 0 drivers), and neither run reported a scroll or follow-state mismatch.
- **At rest:** `deck motion rest` read 21 updates/s before the readings, taken while the deck was in active use, and 5 updates/s after, which is inside the budget of 10.
- **Quieted:** each burst paused 35–36 running animations and played them again afterwards.

**Census (width run).** 22,858 elements, 1,468 stacking contexts, 7,220 render-layer candidates and 145 sticky elements. These agree exactly with `__tugMotion.layers()`, so the page's mirrored predicates have not drifted. Largest panes: `tug/goodly-ferry` 6,693; Overview 6,662; `tug/toned-suit` 3,080; `tug/silver-smock` 2,194; Layout 1,352.

| Subject | Elements | Stacking contexts | Candidates | Sticky |
|---|---|---|---|---|
| Overview (1 column, 94 cells) | 6,585 | 476 | 1,509 | 94 |
| Parked workspaces (1 layer) | 2,068 | 100 | 1,012 | 3 |
| Largest transcript (`tug/goodly-ferry`, 6 cells, 5 skipped) | 6,365 | 368 | 1,795 | 29 |

**Baseline walk.** With the width driver, the walk is 5.13 ms by mean (spread 1.12 across 25 baselines) and 5.0 ms by p50 (spread 2.0), over a floor of 2.0 ms. With the transform driver it is 2.87 ms by mean (spread 1.33) and 2.0 ms by p50.

**Arms, width driver.** Delta is the paired baseline's walk minus the arm's, so a positive delta means the arm made the walk cheaper. Prices are milliseconds per 1,000 elements, stacking contexts and candidates removed, taken from the mean delta.

| Arm | Mean delta, ms (per round) | Moved (mean / p50) | Removed el / sc / cand | Price per 1k el / sc / cand |
|---|---|---|---|---|
| `overview-skip` | +0.73 (1.18, 0.58, 0.70, 0.73, 1.00) | no / no | 6,372 / 452 / 1,457 | 0.12 / 1.62 / 0.50 |
| `overview-absent` | +0.57 (1.13, 0.92, 0.43, 0.50, 0.57) | no / no | 6,585 / 476 / 1,509 | 0.09 / 1.19 / 0.38 |
| `parked-absent` | +0.02 (−0.15, 0.02, 0.35, −0.53, 0.25) | no / no | 2,068 / 100 / 1,012 | — (noise) |
| `transcript-absent` | +0.08 (0.80, 0.08, 0.30, −0.58, −0.10) | no / no | 6,365 / 368 / 1,795 | — (noise) |
| `transcript-unskipped` | −1.30 (−1.02, −1.45, −1.18, −1.43, −1.30) | **yes** / no | −6,009 / −352 / −1,696 | 0.22 / 3.69 / 0.77 |

**Arms, transform driver.** The transform walk is smaller and its deltas sit inside its own spread. The two Overview arms stay positive in every round; nothing else holds a sign.

| Arm | Mean delta, ms (per round) | Moved |
|---|---|---|
| `overview-skip` | +0.68 (1.15, 0.22, 0.68, 1.08, 0.62) | no |
| `overview-absent` | +0.45 (1.10, 0.77, 0.38, 0.40, 0.45) | no |
| `parked-absent` | +0.08 (−0.30, 0.33, 0.08, −0.40, 0.45) | no |
| `transcript-absent` | +0.08 (0.08, −0.75, 0.37, −0.03, 0.37) | no |
| `transcript-unskipped` | +0.02 (−1.27, 0.27, −0.40, 0.02, 0.43) | no |

---

## Evidence {#evidence}

**[F01] On this deck a style change costs about 5 ms of walk, and the deck's population puts most of it there.** The width driver reads 5.13 ms above a 2 ms floor on 22,858 elements, which is consistent with the source brief's 6–7 ms on 23,116. **(verified, measured)**

**[F02] The page clock ticks in whole milliseconds.** A release deck page is not cross-origin isolated, so WebKit coarsens `performance.now()` to 1 ms. Every sample is an integer, and a p50 cannot register a change smaller than one millisecond. The verb now reports a mean-based walk beside the p50, because the mean of 60 samples taken at varying phases of the tick carries the fraction the median rounds away. Every verdict below reads the mean. **(verified, measured: 2,000 consecutive `performance.now()` reads returned one value)**

**[F03] Skipping a row with `content-visibility: auto` takes it out of the walk.** The production skip on the Session transcript is the control. Forcing its five skipped cells (6,009 elements) to render added 1.30 ms in all five rounds, the only arm whose mean cleared the noise bar. Removing that same list outright, with those cells still skipped, saved 0.08 ms, which is noise. A skipped row's population is therefore not walked, and the transcript comment's claim holds. **(verified, measured, width driver)**

**[F04] On this WebKit a row becomes skipped only when its proximity to the viewport changes.** A cell given `content-visibility: auto` while already 15,000 px above the viewport stayed rendered. It fired no `contentvisibilityautostatechange` event, and a 1 px scroll did not change that; a scroll that carried cells in and out did. `checkVisibility({contentVisibilityAuto: true})` returns true even for cells `TugListView` has marked `data-cv-skipped`, so on this engine that option is ignored and the event is the only gauge. A shipped Overview skip would therefore engage for rows that scroll away after being stamped (every live post the column follows past), and not for rows loaded already off-screen until the reader scrolls through them. The `overview-skip` arm sweeps the column through once (and restores it) so that it reads the skip as it stands after use. **(verified, measured)**

**[F05] The Overview is about 11% of the walk while holding 29% of the deck's elements.** Removing it saved 0.57 ms and skipping its unseen rows saved 0.73 ms, both positive in all five rounds of both drivers but under the run's noise bar (the baselines' own mean spread, 1.12 ms). The skip saved as much as removal did, which is consistent with [F03]: 93 of its 94 cells were skipped. **(measured; the effect's sign is consistent, its size is under the run's noise bar)**

**[F06] The Overview's stacking contexts are four per post plus its live-work dots.** Each post contributes `div.tug-transcript-entry.overview-post`, `div.tug-transcript-entry__pin` (the sticky attribution header, which accounts for every one of the column's sticky elements, one per post), `div.tugx-md-block` and `span.overview-post-z1b-copy`. That is 376 of 476. Each of the 25 pulsing dots adds four more (`-dot-well`, `-dot`, `-ring-well`, `-ring`), for 100. **(verified, census)**

**[F07] A parked workspace of this size does not measurably pay into the walk.** Removing the one parked layer (2,068 elements, 1,012 candidates) moved the walk by +0.02 ms under the width driver and +0.08 ms under the transform driver. A larger parked layer was not read: an earlier attempt caught a parked layer of 20,016 elements, but the user switched workspaces during that run and its numbers were discarded. **(measured, for a 2,068-element layer)**

**[F08] No single population term prices the walk.** The Overview arms and the unskipped transcript disagree on every term's price by 2–3× (elements 0.09–0.12 vs 0.22; stacking contexts 1.2–1.6 vs 3.7; candidates 0.38–0.50 vs 0.77). The transcript cells cost more with fewer elements (6,009 vs 6,585) and fewer stacking contexts (352 vs 476), so neither of those terms is the price by itself. Candidates move in the right direction (1,696 vs 1,509) but too little to account for a 2.3× difference. Whatever separates a transcript row from an Overview post (likely the layers WebKit actually composites, which no script can count) is not visible in these three terms. **(measured; not separated by this reading)**

**[F09] `parked-absent` could not originally restore a scroll offset inside a parked layer, and now does.** A parked layer is `content-visibility: hidden`, so a `scrollTop` written into it after the re-show had no box to land in. One run left a parked `div.tug-list-view` scrolled to its top. The restore now lifts the layer to `content-visibility: visible` (still `visibility: hidden`, so nothing shows) for the instant of the write. A single-arm run afterwards reported no mismatch. **(verified, measured)**

---

## Verdicts {#verdicts}

- **Pricing term:** not separated by this reading. No term's per-unit price agrees within ±30% across the arms that moved the walk ([F08]). Elements and stacking contexts are each contradicted by an arm that removed fewer of them and cost more.
- **Does `content-visibility: auto` leave the walk:** yes, for rows the engine has actually skipped ([F03]). The Overview pair agrees in direction: skipping saved as much as removal ([F05]). On this WebKit a row is skipped only after its viewport proximity changes ([F04]).
- **Do parked workspaces pay:** not measurably, for the 2,068-element layer present ([F07]). A large parked layer remains unread.
- **The Overview's stacking contexts and sticky elements:** four contexts per post, one of them the sticky attribution pin (the column's only sticky elements), plus four per live-work dot ([F06]).
- **The skip bar (build the Overview skip only if `overview-skip` moved the walk and saved at least 25% of what `overview-absent` saved):** **not met.** The second half holds (0.73 against 0.57, or 128%). The first does not: the median delta of 0.73 ms is under the run's own baseline spread of 1.12 ms by mean, and under 2.0 ms by p50. The effect is positive in every round of both drivers, so it is a small saving below the noise floor rather than none. The Overview's whole share of the walk is about half a millisecond on this deck.

---

## The Overview's row count {#row-count}

Put to the user with the numbers above: the Overview at 94 posts cost about 0.57 ms of a 5.1 ms walk, about 0.006 ms per post, which extrapolates to about 3 ms at the old ceiling of 500 rows; skipping its unseen rows was not built. The choices were to keep 500, or to hold 150, where the Overview's share stays under 1 ms.

**Answer (2026-10-02): "Hold 150."** `OVERVIEW_MAX_ROWS` is now 150, and the card's opening request is clamped to it, so a `card_rows` default set above the ceiling no longer asks for a tail the store would trim on arrival. Posts past the ceiling stay in the ledger.

## Aging reading {#aging-reading}

The source brief's [F05] question (whether lost frames on an aged deck track element count, the Overview, or something the census does not show) needs hours of ordinary use, so it is the user's to take:

1. Relaunch Tug.app. Then run `tugtool --version`, `tugtool deck motion enable --instance release-main`, `tugtool deck motion walk --instance release-main --rounds 5 --frames 60 --json > walk-fresh.json`, and `tugtool deck motion disable --instance release-main`. Keep the window in front and no session mid-turn.
2. After several hours of ordinary use, run the same commands into `walk-aged.json`.
3. Compare the two censuses and baseline walks, and the Overview arms' shares.

| | Build | Elements | Baseline walk (mean) | `overview-absent` | Notes |
|---|---|---|---|---|---|
| Harness, fresh | `9714b6f37` (debug, `at0727`) | 5,422 (533 stacking contexts) | 4.97 ms, spread 1.33 | +1.03 ms, not moved | 30 Overview posts; `c1` the slice, three stub sessions bound and empty |
| Harness, aged | `9714b6f37` (debug, `at0727`) | 15,913 (1,424 stacking contexts) | 5.60 ms, spread 0.83 | −0.10 ms, not moved | 150 posts, all mounted; three stubs streamed 16 rows each and evict to 6; every scroller swept; a fold and a split driven |
| User's deck, as found | 0.8.18 `9714b6f37` (release), up 1 h 18 min | 30,097 (1,945 stacking contexts) | 5.58 ms, spread 4.82 | +0.75 ms, not moved | 90 Overview posts; no arm moved the walk past its spread; `overview-skip` left the column off its live edge |
| Harness, fresh, after | `f87299f03` (debug, `at0727`) | 4,209 (367 stacking contexts) | 4.27 ms, spread 0.67 | −0.03 ms, not moved | 30 posts held, 11 mounted, one stacking context each; `transcript-absent` +0.47 ms, not moved |
| Harness, aged, after | `f87299f03` (debug, `at0727`) | 6,960 (538 stacking contexts) | 5.10 ms, spread 1.73 | +0.53 ms, not moved | 150 posts held, 11 mounted; three stubs at 16 rows evict to 6 and peak at 6 through the fold and the split; both fold drives sealed, the split launched no beat; `transcript-absent` +0.37 ms, not moved |
| User's deck, as found, second | 0.8.18 `9714b6f37` (release), up 2 h 22 min | 38,056 (2,908 stacking contexts) | 7.23 ms, spread 12.57 | +0.45 ms, not moved | Still `main`, so not an after: 147 Overview posts, all mounted, each with a sticky pin and four contexts of its own, and 74 of them a live session dot of four more; no arm moved the walk past its spread; `overview-skip`, `parked-absent` and `transcript-absent` left their scrollers off their places |

**The ceiling margin is 1.33 ms.** It is the fresh harness baseline's own mean spread ([P02] of the arc's plan; an earlier run of the same reading read 1.10), and `at0727` carries it as `CEILING_MARGIN_MS`. On the harness, tripling the document (5.4k to 15.9k elements, 533 to 1,424 stacking contexts, the Overview from 30 to 150 mounted posts) moved the mean walk by 0.63 ms, inside the margin, and no arm read as moved on either deck. At this population the walk does not track what is mounted the way [F02] of the population-ceiling brief expected, so the after-reading is read against the census as much as the walk.

**After.** With the Overview windowed and pinned by one header, the aged harness deck holds 6,960 elements and 538 stacking contexts where it held 15,913 and 1,424, and the Overview mounts 11 of its 150 posts at one stacking context each where it mounted all 150 at four. The aged mean walk is 5.10 ms against a fresh 4.27, 0.83 ms apart, inside the 1.33 ms margin, and `at0727` now asserts that ceiling, the Overview's mounted count, no full mount through either reflowing settle, and both fold drives sealed. The walk moved less than the census did, as the before-reading said it would. The user's deck still runs `main`, so its second reading is the as-found deck again, aged further: 38,056 elements with all 147 posts mounted. Its reading of this arc's code is owed after the join, and the fresh arm at the next relaunch.

**Full-mount peaks.** None were reached. The fold and the split were driven on `c1` and slot 0, and the three transcripts that evict at rest (16 rows, 6 mounted) peaked at 6 through both drives with no eviction fallback: neither gesture changes an evicting transcript's width on this deck. The Overview held all 150 posts throughout, as it does at rest. The transcript's full-mount path is reached by a direct width write, which `at0330`'s reflow case reads.

## After (release) {#after-release}

The slot for a confirming reading of an Overview skip on a release build carrying it. No skip was built from this reading, so the slot stays empty unless one is.
