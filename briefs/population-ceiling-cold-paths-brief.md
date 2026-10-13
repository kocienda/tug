<!-- brief-skeleton v1 -->

# The population ceiling's cold paths

**Purpose:** The deck's mounted population is bounded by the viewport at rest and not at the moments the ceiling was for: a reopened or relaunched transcript mounts all its loaded turns once, the Overview mounts its whole opening page once, a hidden tab's backlog mounts whole on reveal, and a row with no height mounts under the beats of a settle. The test that asserts the ceiling passed before the change. This brief closes the cold paths and makes the bar one that can fail.

Fixup to stage 4 of `briefs/main-thread-headroom-program-brief.md` (`briefs/population-ceiling-brief.md`, landed as `86c646770`).

---

## Purpose {#purpose}

The 2026-10-12 audit's verdict on stage 4: "bounded by the viewport is true of this code's steady state and unverified on the deck the brief was written for." The brief's [B01] said rows outside the viewport plus a margin are not mounted; the implementation's exception is per run and uncapped. The brief's open question, whether the window holds its mounted set from `arm` to land, was answered "no" for a heightless row.

---

## Evidence {#evidence}

**[F01] A cold ledger suspends to a full mount.** `resolveEvictSegments` (`tugdeck/src/components/tugways/internal/list-view-window.ts:475`): `if (outside > 0 && !anyHeight) return { kind: "suspended" }`, and `batchLoading` renders the full range (`tug-list-view.tsx:3134-3140`). `HeightIndex` is in memory only, so every restored, reopened or relaunched card mounts all loaded turns on its first commit. A 500-turn card mounts 500 rows at every launch, which is the over-mount shape `briefs/view-zoom-performance-and-feedback-brief.md` measured at 6–10 s. **(verified, read from the code)**

**[F02] Missing runs are never capped.** `list-view-window.ts:422-427`, `:483-494`: a stale run is capped at eight rows and a viewport of height; a run of rows never measured is mounted whole. Rows appended while `viewportHeight === 0` (a hidden tab, a streaming background card) accumulate unmeasured and mount as one uncapped segment on reveal; the comment near `tug-list-view.tsx:3253` says so. The Overview's opening request is `min(cardRows, 150)` posts in one page (`overview-store.ts:397`) and each `loadOlder` page (`:611`) is a prepend of unmeasured posts, so the card mounts about 147 posts once on open and a page on each load. **(verified, read from the code)**

**[F03] A heightless row breaks the motion hold.** `tug-list-view.tsx:3165-3176` and `overview-card.tsx:1086-1100` freeze the window only while every out-of-window range is covered; a row with no height takes the resolver path and mounts. A turn starting mid-fold or a post arriving mid-settle is a layer transaction under the beats, which [D9] forbids. The commit message says "unless a row has no height". **(verified, read from the code)**

**[F04] The Overview drains a width change with no restore target.** `overview-card.tsx:1452-1470` marks every height stale and drains; `scrollTop` is whatever WebKit leaves as spacers resize under the reader. `TugListView` has a drain hold (`installDrainHoldRef`) and the Overview does not. [L23]. **(verified, read from the code)**

**[F05] The zoom rescale path relies on scroll anchoring the same commit says WebKit lacks.** `tug-list-view.tsx:3665` says "scroll anchoring holding the reader's place"; `:4232` says "WebKit has no scroll anchoring". The rescale keeps the ledger and installs no target. The no-episode reflow anchor (`:3384-3392`, `:3795`, `:4240-4250`) is a row plus pixel offset sampled under a held observer, and `at0330` asserts the top row within 1 px, not the reader's line. **(verified, read from the code)**

**[F06] The ceiling assertion cannot fail for the reason it exists.** `at0727-population-ceiling-reading.test.ts:616-618` asserts the aged mean walk within the fresh one plus `CEILING_MARGIN_MS = 1.33`. By the stage's own before-reading (fresh 4.97 ms, aged 5.60 ms) the pre-change code passed it with 0.63 ms to spare; and the margin is the fresh reading's own spread, so a single noisy run can fail it. The discriminating assertions are the other two: aged Overview cells below the post count, and no full transcript mount through a reflowing settle. The drive comment at `:446-448` records 32 updates/s at rest after the sweep and proceeds. **(verified, read from the test and the readings)**

**[F07] The Overview windows in a second idiom.** About 450 lines of `overview-card.tsx` (`:1040-1125`, `:1194-1230`, `:1439-1510`, `:1604-1640`, `:1760-1815`) re-implement the list view's hold predicate, hidden-viewport hold, selection and focus pinning, stale-on-width rule and segment-with-spacer rendering, with a card-local `Map` instead of `HeightIndex`, a second gap convention, and a bare `new ResizeObserver` where the list view's are held. Both are correct today; there is no parity test between them. `MeasureLedger.coversRange` is required by the interface and never called by the function that takes it (`list-view-window.ts:392-394`). **(verified, read from the code)**

**[F08] What the user's deck read.** The record's aged readings of the user's deck were taken on `main` before this stage: 30,097 and 38,056 elements, 147 Overview posts all mounted, a 7.23 ms walk. On 2026-10-12, relaunched with every stage on, it read 11,253 to 14,750 elements, 655 to 840 stacking contexts, and an Overview of 961 to 1,115 elements, across the audit's drives. The fresh-after-relaunch arm and the aged reading of this code are still owed. **(verified, measured 2026-10-12; aging not yet read)**

---

## Decisions {#decisions}

**[B01] A cold card windows from its first commit.** Measured heights persist per session with the card's state bag, so a reopened or relaunched transcript has a ledger before its first render. Where a row has no persisted height, the window estimates from the ledger's median and corrects on measurement under the list view's restore target, exactly as a drain already does. The "suspended" branch is removed: no state mounts the whole loaded window.

**[B02] Missing runs are capped as stale runs are.** A run of never-measured rows mounts through the same eight-row, one-viewport segment, nearest the window first; the unmeasured remainder is held outside the scroll geometry by the extent floor the list already keeps until it is measured. The hidden-tab backlog, the Overview's opening page and each `loadOlder` page drain rather than mount whole. The Overview's opening request stays a page in the store; what changes is how many of its posts are in the DOM at once.

**[B03] The motion hold holds the mounted set, heightless rows included.** While a gate is closed, an append keeps `itemCount` at the held value and defers the mount to `afterGesture`; the list and the Overview re-render exactly the window and segment they last committed, with no exception. This is the brief's open question answered the way [D9] requires, and the content pop at release is the accepted one.

**[B04] The Overview takes the list view's drain hold.** A width change anchors on the top mounted post key and its offset before the drain and re-lands per commit, through the same resolver the list view uses. [L23].

**[B05] The zoom rescale installs the drain hold, and the reflow anchor is an element.** The rescale path runs the drain-hold installer; the no-episode reflow anchor is sampled from the pre-reflow commit as an element plus offset, not a row index plus pixel offset; the comment at `tug-list-view.tsx:3665` is corrected. `at0330` gains a mid-row reader case.

**[B06] The ceiling bar becomes one that discriminates.** `at0727` keeps the census and mount-peak assertions and demotes the walk comparison to a `note()` until a margin is read that separates the pre- and post-stage code. The 32 updates/s at rest after the sweep is identified, not proceeded past: the test refuses to read a deck that is not at rest, as the verb does.

**[B07] One windowing implementation.** The Overview's hold predicate, hidden hold, pin tracker, stale rule and segment renderer are extracted to a `useOverviewWindow` hook built on the same pure helpers the list view uses, with one gap convention and `heldResizeObserver`. `MeasureLedger.coversRange` leaves the interface or is used. The pure `computeOverviewWindow` already lives in `overview-window.ts`; the hook half follows it out of the 2,700-line card.

*As built (`347506333`):* the collapse landed. `useOverviewWindow` (`tugdeck/src/components/overview/use-overview-window.ts`) runs `computeWindow` and `resolveEvictSegments` from `internal/list-view-window.ts`, the list view's own window math, over a post-keyed `KeyedHeightLedger`, with `heldResizeObserver` and the list view's mount and retain margins. `MeasureLedger.coversRange` left the interface. The card is 2,374 lines. With one implementation there is no second one for a parity test to hold, which closes the gap the 2026-10-12 audit named. `tuglaws/ingest-and-render.md` states the shared window as [L36].

**[B08] The aged reading is taken on this code.** On the user's deck: census and walk fresh after relaunch and after a working day with sessions streaming through it, written into `briefs/compositing-walk-readings.md`'s aging table and the program record. This is the stage's owed reading and this brief's reading of record.

---

## Open Questions {#open-questions}

- **Where do persisted heights live, and how are they invalidated?** The card state bag is the [A9] protocol's home for per-card user-visible state; heights are derived appearance, so they may instead ride a sidecar keyed by session and width. A height saved at one width is wrong at another; the stale tier already handles that if the sidecar records the width. The arc decides.
- **What does the Overview's opening look like when its page drains instead of mounting?** The follow-bottom reader sees the newest posts first and the rest fill above under the restore target. Settled by looking on the user's deck.

*Answered as built.* Heights persist in the card state bag, `bag.components`, under `session-card-transcript-heights` for the transcript and `overview-heights` for the Overview, keyed by row or post. A width change re-wraps every row, so every height goes stale and drains through measure segments, as a stale height always did. That is how a height saved at one width stays correct at another.

---

## Non-goals {#non-goals}

- **Changing what the Overview shows or how many posts it holds.** Still the user's product call.
- **Windowing the Cards, Jots and Arcs lists.** They run inline without eviction; outside the stage's scope and read as a later finding if their size shows in a census.
- **Cutting stacking contexts by hand.** The stage's reading already took each post to one.

---

## Exit {#exit}

**An arc.** The shape: the motion hold without exception ([B03]) first, because it is the [D9] clause; then the cold ledger and the missing-run cap ([B01], [B02]); then the Overview's drain hold and the zoom path ([B04], [B05]); then the bar ([B06]) and the extraction ([B07]); the aged reading ([B08]) at the join. Read with `at0330`, `at0727`, `at0728`, `at0729` and the Overview files, and the user's deck fresh and aged.
