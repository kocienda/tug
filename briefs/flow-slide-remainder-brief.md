<!-- brief-skeleton v1 -->

# The flow slide: what remains after the loose threads

**Purpose:** The flow slide delivers its frames again on a freshly launched deck, and the instrument that says so is now one repeatable command. What remains is four pieces of work: a focus engine that re-projects about nine times per activation, two-thirds of the click's lead block that nothing has named, an occasional mid-slide frame, and the question of whether a long-running deck loses the frames again.

---

## Purpose {#purpose}

`briefs/flow-slide-loose-threads-brief.md` set out to make the slide's readings repeatable and to attribute what they found. That work landed, and the user, reviewing what was left:

> We can skip `--tween`, but I'd like a new brief on the remaining work. I'll run an arc against them after you write it.

The gesture is the one both earlier briefs were written about: a click on a session row in the Cards card that moves focus to another session card and slides the flow strip to it. The loose-threads brief's findings `[F01]`–`[F17]` are the evidence base here and are cited by that brief's name rather than repeated; the remaining-costs brief (`briefs/flow-slide-remaining-costs-brief.md`) is cited the same way.

---

## Evidence {#evidence}

**[F01] The loose-threads work is landed, and on a fresh launch the slide delivers its frames.** `tugtool deck motion slide` exists with `--sample`, `--queries` and `--json` (`f7f91b70c`, `e85909ac8`, `1156af5a0`); the covers-check is green; the responder-chain cache is in. The baseline every later reading compares against is build `1156af5a0`, freshly launched, 10,958 elements and 3,503 render-layer candidates, sixteen clicks between `tug/goodly-ferry` and `tug/goodly-treat`: 7–11 frames in the first 200 ms, first frame 50–63 ms (one 86), first two gaps ~24 and ~21 ms, no frame at the settle's hand-back, lead blocked 69–116 ms beyond an 8 ms heartbeat cadence, settle on at 45–82 ms and off at 440–507 ms, selector queries 19.5 ms per click. **(verified, measured with the verb)**

**[F02] The day's lost frames came with process age, and size may be only its symptom.** An A/B on fresh launches — the same tree with and without the responder-chain cache — read the same frames within noise (loose-threads `[F17]`). Every reading that lost frames (loose-threads `[F12]`–`[F14]`: 2–7 early frames, 40–95 ms early gaps, 26–52 ms hand-back frames) was taken on one WebContent process that had run since 08:26, whose element count grew from ~11k to ~22k as transcripts and the Overview accumulated; a relaunch shed both. Whether frames degrade again as this build ages, and whether they track element count, the Overview, or something the census does not show, has not been read. **(verified that a relaunch restored the frames; the aging behaviour is not measured)**

**[F03] The focus engine projects about nine times per activation, and every projection scans the whole document three times.** `FocusManager.reproject` (`tugdeck/src/components/tugways/focus-manager.ts`) is called synchronously from about fifteen state-change sites — `setKeyCard`, key-view changes, default-ring registration and others — and an activation passes through several. Each pass, `applyProjection`, clears stale marks with three document-wide `querySelectorAll` scans (`[data-key-view]`, `[data-key-within]`, `[data-default-ring]`), each seen 9.2 times per click; `computeProjection` looks one responder up by `[data-responder-id="…"], [data-tug-focusable="…"]` 25 times per click (4.9 ms) and `legalKeyboardElement` scans `[data-tug-key-sink]` 7.3 times. Together about 10 ms of the fresh lead, growing with the document. The engine owns these attributes — `applyProjection`'s comment says the clear pass is document-wide only to wipe a mark a just-deactivated context left behind — and the projection is documented as synchronous so behavioural readers in the same task see the marks. **(verified, measured with `--queries` and read from the code)**

**[F04] About two-thirds of the lead block is not attributed, and a native sample cannot name it.** On the fresh baseline the lead is blocked 69–116 ms and selector queries account for ~17 ms of it. The only process sample of the gesture (loose-threads `[F14]`, on the aged process) put WebContent's main thread at 41% script, and by the task it ran in: 36% microtasks, 23% the click task itself, 17% the rendering update. The script is JIT code, which `sample` shows only as `???` — 2,249 samples sat unnamed under a microtask drain. Which functions, or which React commits, pay is not known. The deck carries an activation census (`tugdeck/index.html`) that earlier work used to label React commits by origin; it was not read or used in this work. **(verified for the split; the attribution is not done, and the census's fitness for it is unconfirmed)**

**[F05] A ~27 ms frame still lands mid-slide in some clicks, and in the last reading only in one direction.** On the fresh `1156af5a0` baseline, a 27–29 ms frame at 362–366 ms after the click appeared in four of sixteen clicks — all four toward `tug/goodly-ferry`, the larger card (3,252 elements against 494). The A/B reading without the cache showed none at that time. It is the frame remaining-costs `[F05]` first saw at 340–356 ms. Nothing has attributed it. **(verified that it occurs; cause not investigated; the direction pattern rests on one reading)**

**[F06] The verb has known limits, and they shape how a reading is trusted.** The page clock ticks in whole milliseconds, so `--queries` times are the share of calls that crossed a tick — sound summed over many calls, meaningless for one. `--sample` now samples at 5 ms because at 1 ms it stopped WebContent so often the frames were not real; frame numbers taken with it are flagged as perturbed. The heartbeat on this deck free-runs at 7–9 ms, so lead blocking is read as excess over the measured cadence (loose-threads `[F15]`); every lead figure before that correction read high. One reading from a session mid-turn carried 30–60 ms frames through the whole window (loose-threads `[F12]`), while later readings from a mid-turn session matched quiet ones. **(verified)**

---

## Decisions {#decisions}

**[B01] The focus engine stops scanning the document to clear its marks, and the projection stays synchronous.** The engine owns `data-key-view`, `data-key-view-kbd`, `data-key-within` and `data-default-ring`, so it can remember which elements it marked and clear exactly those, and memoize the responder lookups within one pass. Every reader that relies on the marks being current in the same task keeps that guarantee, because the number of projections does not change — only what each one costs. The argument: `[F03]` prices the scans at ~10 ms per click and growing with the deck, and this removes them without touching the order of anything. A fix lands only with a `--queries` reading on the release deck showing the scans gone and the frames no worse, and the focus app-tests green. `focus-manager.ts` fans out to 29 app-tests, past the 20-file selection budget, so the run is chosen deliberately rather than by `app-test-changed`.

**[B02] The rest of the lead block is attributed from inside the page before anything is designed against it, and the instrument is the verb.** A native sample cannot name JIT code (`[F04]`), so the attribution has to come from the page: which tasks and microtasks run in the click's first 260 ms, how long each takes, and what queued them — React commits by origin first, since the microtask share is the largest. Whether the deck's activation census can supply that is the first thing to find out; if it can, the verb reads it per click; if not, the verb grows its own recorder, as `--queries` did. This is the loose-threads brief's non-goal carried forward: no reading is written by hand again.

**[B03] The mid-slide frame is attributed only if a quiet reading reproduces it.** `[F05]` rests on four clicks in one reading and none in the next. If it recurs, the verb tags each long frame with what ran in it — the queries, the settle's phase, and whatever `[B02]`'s recorder attributes — so the frame's cause is read rather than guessed; the one-direction pattern is the first thing to check.

**[B04] The aging check is the user's reading, taken when the deck has aged, and it does not block the arc.** It needs hours of ordinary use, which no stage can supply. It is the same command as the `[F01]` baseline, with the census beside it; if frames have degraded, the aged process is then read with `--sample` and `--queries` and its census compared pane by pane against the baseline's, so what accumulated is named. Its result decides how much the other items matter — a deck that slows with age makes `[B01]`'s and `[B02]`'s costs larger every hour — but none of them waits for it.

**[B05] A conclusion rests only on a reading that carries its census and build, and on a quiet deck when the numbers are close.** `[F06]` shows a working session can contaminate a reading and sometimes does not. A reading taken from a session mid-turn is fine for counts and for large effects; any conclusion that turns on a few milliseconds or a few frames is confirmed by a run the user takes with no session working. Every recorded reading names its build sha and its census.

**[B06] `--tween` is dropped.** The bare-tween bisect asked whether an animation's start pays the same cost as the gesture's; with the frames restored on a fresh deck and the remaining costs attributable to script and queries, the answer would change nothing this work does.

---

## Open Questions {#open-questions}

- **What does a long-running deck accumulate that a fresh one does not?** Settled by the aging reading (`[B04]`); the census says whether it is elements, the Overview, or neither, and a sample of the aged process says whether it is the collector.
- **What is the microtask script in the click's lead?** Settled by `[B02]`'s attribution. Whether React's commit work is most of it is the leading guess, not a finding.
- **Why did the mid-slide frame appear only toward the larger card?** Settled by a quiet reading that reproduces it (`[B03]`), or retired if none does.

---

## Non-goals {#non-goals}

- **Coalescing projections to one per task.** It would cut the nine passes to one, but readers in the same task would see stale marks until the coalesced pass ran — the guarantee `applyProjection` documents. `[B01]` gets the cost down without giving that up.
- **A new animation primitive, a compositing-walk reduction, or the Overview's size.** These belong to the unification work (`briefs/graphics-animations-asks.md`) and to the user, as the loose-threads brief's `[B06]` decided.
- **Loosening any frame bar.** `at0622`'s lead clauses stay where they are.
- **Readings written by hand.** If the verb cannot take a reading, the verb is extended.
- **`--tween`.** Dropped, per `[B06]`.

---

## Exit {#exit}

**An arc.** Its first step is the focus engine's tracked marks (`[B01]`), because it is designed, contained, and measurable with the verb as it stands. Then the lead-block attribution (`[B02]`): find out whether the activation census can attribute the click's microtasks, extend the verb accordingly, take the reading, and record what it names before anything is fixed. The mid-slide frame (`[B03]`) follows only if a quiet reading reproduces it. The aging reading (`[B04]`) is the user's, can land at any point, and is recorded beside the `[F01]` baseline when it does.
