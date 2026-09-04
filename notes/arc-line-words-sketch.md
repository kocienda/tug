# The arc line says one thing, in English

**Status:** sketch, decisions settled 2026-09-04. Ready for `/arc`. The five calls are recorded under [Decisions](#decisions).

The complaint: `⚒ 3/6 implement base overlap (1) planned` is nonsense. It is —
and it is nonsense for a structural reason, not a wording one, so the fix is a
grammar rather than a thesaurus.

## Why it reads the way it does

The line is assembled by three mechanisms that never met:

- **The note** is the phase's *key* — `implement`, `review`, `join` — the
  internal enum spelled in lowercase and set as text. It restates what the lit
  cell and the glyph beside it already say, so the phase is on the line three
  times and named in words once, badly.
- **The facts** are `arcMetaFacts`' labels: noun phrases with a count in
  parentheses — `base overlap (1)`, `replay conflicts (2)`, `fit unverified` —
  the names of *conditions*, written for a tooltip's key column and then set
  in a sentence's position.
- **The kind** was appended as a bare adjective (`planned`) with nothing to
  modify. That one is already off the line as of `40e274411`; the screenshot
  predates it. It is still the clearest symptom: a mechanism that appends
  words will append any word.

Nothing joins them. There is no connective, no verb, no ranking beyond source
order, and the vocabularies do not agree with each other or with the join
register one line below, which speaks in sentences (`Ready to join`,
`Reconciling with main`). Six of the ten facts `arcMetaFacts` derives are
filtered off before paint on every surface that calls it — the function
composes labels nobody reads.

## The rule

> **The line is one clause: what the arc is doing, then what is in its way.**
> `[track] [glyph] <Doing> [i/N] · <in the way>`. Every word on it is a word a
> person would say aloud about the arc, and every word on it is derived once.

The screenshot's line becomes:

```
▬▬ ▬▬ ▬▬ ▮▮▮▯▯▯ ▭ ▭   ⚒ Implementing 3/6 · 1 file also edited on main
```

The track and the glyph stay where [D168] put them. What changes is every
word after the glyph, and every hover sentence behind them.

## The phase word

The line is about what the arc is DOING, so the word is a verb in progress —
the stage's own name, inflected — not the stage's key. Title Case, matching
the cells and the Z2 instrument, which already spell their states that way.

Two phases are things *done to* an arc rather than by it — review and audit —
and a plan can sit in either for days with nobody working it. So those two
read differently at rest ([W04]). The model gains one bit, `live` (an arc
run in flight, or a busy holder), which is the fact the track's breathing
already paints.

| Phase | Live | At rest | Today |
|---|---|---|---|
| brief | `Briefed` | `Briefed` | `brief` |
| devise | `Devising` | — (never rests without stopping) | `devise` |
| review | `Reviewing` | `Awaiting review` | `review` |
| implement | `Implementing 3/6` | `Implementing 3/6` | `3/6 implement` |
| audit | `Auditing` | `Awaiting audit` | `audit` |
| join | `Finished` | `Finished` | `join` |

Notes on the two ends:

- **`Briefed`** is a fact, not an activity — the arc has a brief and nothing
  has begun. Under the wheel it lasts seconds; on a document row it is the
  honest resting word.
- **`Finished`** is the phase where the work is over and the join is what is
  left. The register beneath says what the *join* is doing (`Ready to join`,
  `Reconciling with main`, a blocker); the line should not say it twice, and
  it should not say `Join` as though joining were something the arc does
  ([W01]).
- **Implement at rest** keeps `Implementing`: a hand-worked arc between turns
  is still in its implementing phase, and nobody is waiting on anything. The
  fraction rides after the verb ([W02]), in the mono face it has now, only
  while a step is current — so a walked ledger under audit reads `Auditing`,
  not `Auditing 6/6`.

## Stopped

A stop outranks everything, as it does now. The line reads:

```
⛔ Stopped · needs a decision
```

`Stopped`, then the reason word off the record, in danger ink — not
`stopped · needs a decision` in lowercase. *Where* it stopped is the red cell
on the strip, so the line does not say `in review`; the cell's hover does.

The reason words are the closed vocabulary `ArcStopReason::as_str` writes to
the log, and they are not touched — they are the record. Most read well
inline (`needs a decision`, `stopped by user`, `audit did not mark`,
`stalled`); four do not (`lint`, `no stdin`, `stdin closed`, `arc running`),
and they stay as they are — the hover explains them ([W05]). The hover
carries the explanation the receipt already composes —
`ArcStopReason::sentence` — which today never reaches a face except through
the receipt's text. **The wire carries it**: `ArcRunState` gains
`stopped_why`, the sentence beside the word, so the deck never keeps a second
table of a vocabulary the compiler already closes.

## What is in the way

The facts become clauses, one per condition, ranked loudest first, each with
its explanation on hover. Four survive; the other six are deleted from
`arcMetaFacts` rather than filtered, because no surface reads them.

| Key | Today | Proposed | Tone | Hover |
|---|---|---|---|---|
| conflicts | `replay conflicts (2)` | `2 files conflict with main` (`1 file conflicts with main`) | danger | `Replaying onto main stops on:` + paths |
| overlap | `base overlap (1)` | `1 file also edited on main` (`3 files also edited on main`) | caution | `Uncommitted work on main touches files this arc changes:` + paths |
| fit stale | `fit unverified` | `unverified` | caution | `Verified at 63de5762a onto 40e274411; one of those has moved since.` |
| fit current | `fit verified` | `verified` | subtle | `The tree a join would land was verified at … onto ….` |

`main` is `entry.base`, spelled as it is. "Fit" is `tugtool arc verify`'s
word and stays in the hover; on the line, `verified` / `unverified` is the
whole of what a reader needs.

**How many on the line.** Today every applicable fact is appended and the
line elides at the note. With clauses this long, two troubles at once
(conflicts and overlap together is the realistic pair) would push a rail-width
row off its edge. So: **the loudest clause on the line, and the rest as
further lines in its hover** ([W03]). A reader who sees red hovers it and
gets everything. The `·` separates the phase clause from the trouble clause,
the same mark the register uses.

Deleted outright, with their tests: `arc-stopped` (the line says `Stopped`),
`arc` (the track says running), `kind` (the cell set says planned),
`uncommitted`, `behind`, `replayed` (the checkout's bookkeeping, already
spoken where a gesture turns on it). `NOT_ON_THE_LINE` goes with them.

## Every surface, every variant

A planned arc, six-step plan, worker `tug/fabled-trout`, at read scale.

```
Briefed, wheel about to rotate
  ^rail-promotion ──────────────────────────── ● tug/fabled-trout
  ▮ ▭ ▭ ▭▭▭▭▭▭ ▭ ▭   📄 Briefed

Devising
  ▬ ▮ ▭ ▭▭▭▭▭▭ ▭ ▭   🧭 Devising

Plan written, nobody reviewing
  ▬ ▬ ▮ ▭▭▭▭▭▭ ▭ ▭   🛡 Awaiting review

Review stage seated
  ▬ ▬ ▮ ▭▭▭▭▭▭ ▭ ▭   🛡 Reviewing

Stopped in review, a decision is the user's
  ▬ ▬ ▮ ▭▭▭▭▭▭ ▭ ▭   ⛔ Stopped · needs a decision
                       hover: it met a decision that is yours to make, so it stopped rather than asking

Implementing, main has uncommitted edits to one of its files
  ▬ ▬ ▬ ▬▬▮▭▭▭ ▭ ▭   ⚒ Implementing 3/6 · 1 file also edited on main
                       hover on 3/6: Step 3 of 6 — Collapse the register table and strip the register props

Implementing, replay conflicted AND main overlaps
  ▬ ▬ ▬ ▬▬▮▭▭▭ ▭ ▭   ⚒ Implementing 3/6 · 2 files conflict with main
                       hover: Replaying onto main stops on: … / Uncommitted work on main touches …

Stopped mid-walk, implement idle
  ▬ ▬ ▬ ▬▬▮▭▭▭ ▭ ▭   ⛔ Stopped · implement idle

Walked, audit stage seated
  ▬ ▬ ▬ ▬▬▬▬▬▬ ▮ ▭   ⚗ Auditing

Direct arc, walked, holder gone quiet, nothing marked
  ▬ ▬▬▬▬▬▬ ▮ ▭       ⚗ Awaiting audit

Audit stopped without marking
  ▬ ▬ ▬ ▬▬▬▬▬▬ ▮ ▭   ⛔ Stopped · audit did not mark
                       register beneath: rail-promotion's audit stopped — resume it, or land it unaudited

Audited, fit verified, waiting on the join
  ▬ ▬ ▬ ▬▬▬▬▬▬ ▬ ▮   ⑂ Finished · verified
                       register beneath: Ready to join
```

The same words on the other surfaces:

- **Changes shade arc row, ARC placard head:** identical — they render the
  same block.
- **Receipt row** (`arc stopped · foo · in review — …`): its note reads
  `Stopped · needs a decision`, `Picked back up`, or `Finished · 3 stages` —
  the same words as the line, since it is the same line.
- **Masthead and Cards-card mark** (pill · glyph · fraction, one tooltip):
  `^rail-promotion · Implementing step 3 of 6`, `^rail-promotion · Stopped in
  review · needs a decision`, `^rail-promotion · Finished`. Today:
  `arc rail-promotion — implement · step 3 of 6`.
- **Z2 ARC instrument:** numbers whenever there are numbers, unchanged. Its
  word cases take the same words: `Briefed`, `Devising`, `Awaiting review`,
  `Finished`, `Stopped`, `Cut`. `Awaiting review` fits the cell's 18ch.

## Every hover

One grammar for the cells: **`Not yet <past participle>` · `<present
participle>` · `<past participle>`**, so a reader learns three forms once.

| Cell | Pending | Active | Done |
|---|---|---|---|
| Brief | — | `Briefed` | `Briefed` |
| Devise | `Not yet devised` | `Devising` | `Devised` |
| Review | `Not yet reviewed` | `Reviewing` / `Awaiting review` | `Reviewed` |
| Implement | `Not yet implemented` | `Implementing · 3 of 6 steps closed` | `Implemented · 6 steps` |
| Audit | `Not yet audited` | `Auditing` / `Awaiting audit` | `Audited` |
| Join | `Not yet joined` | `Finished — the join is next` | — |

A stopped cell: `Stopped devising — <sentence>`, `Stopped in review —
<sentence>`… simplest is **`<Active word> — stopped: <sentence>`**, e.g.
`Reviewing — stopped: it met a decision that is yours to make…`. The Devise
cell of a planned arc keeps the kind sentence on a second line.

Today's cell hovers are `devise · done`, `implement · 3 of 6 steps closed`,
`audit — stopped: audit did not mark`.

The rest:

- **The glyph, on the line:** no tooltip. The word is beside it; a bubble
  repeating it is the second copy the line's own doc forbids. It keeps its
  `aria-label`. (The compact mark keeps its one tooltip over all three marks,
  as [D168] settled.)
- **The fraction:** `Step 3 of 6 — <title>`; `Step 3 of 6` when the host has
  no title. Today `step 3 of 6 · <title>`.
- **A trouble clause:** its sentence, then the others' sentences on further
  lines when more than one applies.
- **The note itself:** the elision bubble only, as now.

## Mechanics, briefly

- **One derivation.** `arcReading(model)` in `tug-arc-track.tsx` returns
  `{ word, fraction }` — the phase word above, `Stopped · <why>` when stopped.
  `ArcLifecycleLine` calls it itself; `arcLifecycleNote` and the `note` prop
  every host threads through go away, except that the receipt block keeps an
  override for its three outcomes. `arcPhaseWord` (the glyph's sentence) and
  `arcMarkFraction` read the same function.
- **`ArcTrackModel.live`**, computed beside `arrived` from `arcRunning ||
  holdersBusy`. The strip's breathing can key on it later; this arc only
  reads it for the two resting words.
- **`ArcRunState.stopped_why`** on the wire, from `ArcStopReason::sentence`,
  composed in `ops.rs` where `stopped` and `stopped_stage` already are.
- **`arcMetaFacts`** shrinks to the four clauses, ranked, with a helper for
  the file-count phrase. `NOT_ON_THE_LINE` and `arcLifecycleFacts` are
  deleted.
- **Cell tips** come from a small table of the three forms per phase, so the
  grammar is data rather than string arithmetic.
- **Pins to re-point:** `at0427-arc-divergence-marks` (`base overlap (1)`),
  `at0475-arc-faces` (`arc stopped in review`), `at0483`/`at0484` (the mark
  and the instrument's words), `arc-meta-record.test.ts`,
  `arc-lifecycle-facts.test.ts`, `tug-arc-track.test.ts`, the receipt block
  test. [D168] gets an amendment naming the grammar; `arc-lifecycle.md`'s
  faces section gets the table.

## Decisions

Settled with the user on 2026-09-04.

**[W01] The join phase reads `Finished`.** The work is over and the join is
what is left; the register says what the join is doing. `Audited` was
rejected because a direct arc marks itself and the word would overstate;
`Ready` collides with the register's `Ready to join`; `Done` is the ledger's
word for a step.

**[W02] The fraction follows the verb** — `Implementing 3/6`. With a verb the
count reads as its object; before it, it read as a label again. This amends
[D168]'s stated order `[glyph] [i/N] [phase]` to `[glyph] <Doing> [i/N]`.

**[W03] One trouble clause on the line**, the loudest, with every applicable
clause's sentence in its hover. Two clauses at rail width pushed the row off
its edge, and a reader who sees red hovers it.

**[W04] Review and audit have resting words** — `Awaiting review`, `Awaiting
audit` — and the model gains the `live` bit that tells them from
`Reviewing` and `Auditing`. Without it the line said `Reviewing` over a plan
nobody was reading.

**[W05] The stop reason words are the log's and stay as written.** `lint`,
`no stdin`, `stdin closed` and `arc running` read poorly inline and the hover
sentence explains them; a display spelling beside `as_str` would be a second
table of a vocabulary the compiler already closes.
