<!-- brief-skeleton v1 -->

# The motion record's honesty: unperturbed readings, a true beat label, and the laws that name the new architecture

**Purpose:** The number the headroom program was opened on was read under instruments that cost frames inside the window being judged, labelled by a sampler that charges a set-up's cost to the beat that followed it, and never on the user's deck with stage code. And the architecture changed under five arcs while `tuglaws/` gained one sentence. This brief makes the readings honest and writes the architecture down.

Fixup across `briefs/main-thread-headroom-program-brief.md`, chiefly stages 1 and 3.

---

## Purpose {#purpose}

The 2026-10-12 audit: "They are coherent as architecture… They are not coherent as evidence." The doctrine's own rule (`tuglaws/tuglaws.md`: "Violating any law requires updating the design first — never silently diverge") is met by none of the five stages, because no law names what they built.

---

## Evidence {#evidence}

**[F01] The harness reading is taken under four instruments that cost frames.** `tests/app-test/at0725-streaming-settle-reading.test.ts:300-324` runs every streaming drive with `--tasks --sample`, then reads `deck motion gaps` at `:328` from those drives. `/usr/bin/sample` stops WebContent, the host and the GPU process at 5 ms for the whole drive (`deck_motion_sample.rs:28-33`; the verb's own note says this perturbs the frames, `deck_motion_settle.rs:1082-1085`). `--tasks` takes a stack at every queued task. The commit census walks the whole fiber tree on every commit unconditionally in test mode (`tugdeck/index.html:348`). The verb keeps a `setTimeout(beat, 0)` chain, a subtree `MutationObserver` on `document.body` and its own rAF pump running through the motion (`deck_motion_settle.js:131-154`). No unperturbed drive exists in the file. **(verified, read from the code)**

**[F02] The gap sampler labels a late frame by the beat in force when it arrives.** `settle-gap-sampler.ts:107`: `beat: this.beatOf()` at the late frame's arrival. The first sampled frame precedes the deferred React commit, so the set-up (commit, Last pass, layout, beat creation) falls inside the first measured gap and is labelled by the beat that launched at its end. On the user's deck the rows read `move +79 ms`, `move +86 ms`, `move +92 ms`: set-up cost wearing a beat's name. Under set-up-and-go the set-up is a budget and not a defect, so the label misclassifies a budget as a judder. **(verified, read from the code and the rows)**

**[F03] The user's deck was never read with stage code under streaming.** Every row of the program record says the deck ran `main` and nothing was streaming text. On 2026-10-12, relaunched with every stage on, quiet, 13,399 to 14,750 elements, read without `--tasks` or `--sample`:

| Gesture | Lead | Worst in-motion gap | Land |
|---|---|---|---|
| fold / unfold | 16 ms | 31–42 ms | 30–42 ms |
| slot move | 22–47 ms | 30–89 ms | 28–30 ms |
| split → stack | 16 ms | 53–92 ms | 30 ms |

The always-on rows from the user's own gestures minutes earlier: `move` first frames 79–86 ms late, `shrink` stalls of 67–76 ms at +67, +142 and +151 ms into one window. A native sample across the split drives put the WebContent main thread at compositing 30, rendering update 18, style 14, layer commit 13, script 7 of 131 busy samples. The streaming reading needs three real turns in flight, which only the user can arrange. **(verified, measured 2026-10-12)**

**[F04] `tuglaws/` does not name the architecture.** Across the five stages `tuglaws/` changed by 84 insertions, nearly all arc-doctrine relocation; `animation-doctrine.md:275` gained one sentence on the Worker hold; `wasm-crates.md` the `tugmark` row. No law or decision names the Worker-hosted reducer with the page as mirror, the patch protocol (`tugproto/src/ingest.ts`), the batch cadence and hold, the `RENDERED` feed and its display rule, the sealed-wire invariant `at0725` asserts, or the Overview window. **(verified, `grep -i "ingest worker|RENDERED|render feed" tuglaws/` finds one line)**

**[F05] Brief lines describe the code as it was.** `briefs/streaming-motion-reading-brief.md` [B03] says a `flushSync` inside a closed gate drains the pointer scope's tells; the code drains nothing there, correctly. The program record's stage 1 text says the transcript host "still re-renders on every publish to learn it has nothing to build"; after stage 2 its subscriptions are narrow selectors. `types.ts:170` says a message's `text` "mutates by append during streaming"; the snapshot's copy is pinned under stage 2 and the `PropertyStore` is the live copy. `session-transcript-data-source.ts:875` says a row leaving the window "remounts when it returns"; it re-renders. Stage briefs' open questions (sanitizer allow-list, display period, window margin) are answered in code and not written back. **(verified, read)**

**[F06] Duplications without a written end.** The page's WASM parse has a retirement clause whose trigger cannot fire, because restored rows are never rendered by tugcast; the page find index likewise, because user bodies and notes are page-side. Lezer versus tree-sitter is a permanent fork held by a hand-written salient-token fixture; the two windowing implementations have no parity test at all. **(verified, read)**

**[F07] The sampler's ring feeds a second consumer.** `settle-gap-sampler.ts` is "the one frame record a settle keeps on every deck" and also the ingest Worker's pacing source through `postDisplayPeriod` (`settle-engine.ts:295-307`); before the first settle a 120 Hz display is paced at 60 Hz. Fine, and unnamed in the header. **(verified, read)**

---

## Decisions {#decisions}

**[B01] Every reading of record is unperturbed.** `at0725` drives each gesture once with no `--tasks`, no `--sample` and the commit census off, reads its gap bar from that drive, and only then drives again with the instruments on for attribution. The settle verb gains a `--quiet-instruments` mode (no timer chain, no `MutationObserver`, rAF pump only) for the reading drive. A reading taken with instruments on is labelled as such in every table.

**[B02] A gap row carries both beats.** The sampler records the beat in force at the gap's start and at its end. A row whose start beat is `set-up` is the set-up's cost and is reported under the lead, which is a budget; a row whose start and end are the same beat is a judder inside that beat. `tugtool deck motion gaps` prints both and sums them separately. The one-period bar is read over the second class only, as set-up-and-go [B02] and [B03] already say.

**[B03] The user's deck is read under streaming, on this code, and the record says so.** The program record gains the 2026-10-12 quiet readings above as the first readings of stage code on the user's deck, and a streaming row once the user has three turns in flight; `tugtool deck motion gaps` is read after the user's own gestures, which is the reading nobody has to arrange.

**[B04] The architecture gets its law.** A new `tuglaws/ingest-and-render.md` names: the Worker-hosted reducer as the single authority and the page store as its mirror; the patch protocol and its parity test; one batch per display period and none while a motion is held, with the hold's cap on both sides; the sealed-wire invariant (`at0725`'s zero batches inside a motion); the `RENDERED` feed, its display rule (streaming record drawn as it comes, finalized record only on a matching text hash, parse on `null`), the second barrier if `briefs/rendered-html-second-barrier-brief.md` keeps it, and the one allow-list; and the viewport-bounded population with its two windows. `tuglaws.md` gains the law lines that point at it (a Worker owns the wire; the page draws rendered rows; the population is bounded by the viewport), and `design-decisions.md` the D-numbers for the reversals the stages made (the drain rule, the deferred-notify retirement for streaming, the trust-then-second-barrier decision).

**[B05] The briefs and comments are corrected in place.** The four lines in [F05] are amended with "as built" notes, and each stage brief's answered open questions are written as decisions where the answer lives.

**[B06] Every duplication names its end or its permanence.** The WASM parse and the page find index are written as permanent for the paths tugcast does not serve, with the retirement clause rewritten to say so; Lezer versus tree-sitter is written as permanent with its fixture widened to every token class; the two windowing implementations are collapsed by `briefs/population-ceiling-cold-paths-brief.md` [B07].

**[B07] The sampler's header names its second consumer.**

---

## Open Questions {#open-questions}

- **Does `--quiet-instruments` leave enough to attribute a late frame?** The gap row and the beat rows do; attribution comes from the second, instrumented drive. If a late frame appears only on the quiet drive, that is the finding.
- **Is `tuglaws/ingest-and-render.md` one page or two?** One, unless the render half outgrows it.

---

## Non-goals {#non-goals}

- **Fixing the frames the honest reading shows.** That is `briefs/engine-time-in-the-motion-brief.md`.
- **Loosening any bar.**

---

## Exit {#exit}

**An arc.** The shape: the sampler's two-beat row and the verb's quiet mode ([B01], [B02]) first, because every later reading depends on them; then the reading on the user's deck and the record ([B03]); then the law, the decisions and the corrections ([B04], [B05], [B06], [B07]). It joins with `at0725` reading its bar from an unperturbed drive and the law page cross-checked against the code it names.
