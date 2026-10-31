# Semantic search fixups: the audit's defects, the scan that does not scale, and the help ref chips

**Purpose:** The three semantic-search arcs landed sound code, and an audit of the whole found six small defects, one sizing assumption that was wrong by an order of magnitude, a boot-time integrity probe that blocks on a gigabyte file, a language pin the model does not need, and two visible faults in the Overview's help citations. This brief records what was found and decides the fixes, so one arc can land them and the facility can be left alone with confidence.

---

## Purpose {#purpose}

The user asked for an audit of the implementation of `briefs/semantic-search-seam-brief.md`, `briefs/semantic-history-streams-brief.md` and `briefs/task-shaped-help-brief.md`: "Determine if the changes are actually good, not just the plan in the abstract." The audit's verdict was that the architecture is right and the code is well built, but not yet something to move on from.

The user's own notes from using it: "The citation links under answers in the Overview are *great*. But... they should give me an underline when I hover over them." And: "when I click, the cards open with their title-bar/masthead *off screen*! The bottoms also do not align with the other cards." On the boot probe: it "*can't* be synchronous. we need to run this in the background, non-blocking." On the language pin: "really? why? they support other languages, right?" And the facility has no entry in `tuglaws/design-decisions.md`; the user asked that one be written "on all counts."

---

## Evidence {#evidence}

**[F01] A panicking transcript read retries the same file forever.** `tugrust/crates/tugcast/src/semantic/transcript.rs:769` handles a join error from the blocking read by warning and leaving the job at the head of the queue, so the next unit re-spawns the same read. The IO-error branch at line 762 pops the job. A deterministic panic on one file pins the catch-up worker on that session. **(verified, read from the code)**

**[F02] The embedding helper is respawned without backoff on the caller path.** `semantic/embedder.rs:163` spawns whenever nothing is running, `embed` calls it on every batch, and the death counter that stops automatic restarts after five is never consulted there. A helper that dies on load is relaunched once per source the worker reaches. The test `a_helper_that_keeps_dying_is_left_down_until_someone_asks` enshrines the behaviour. **(verified)**

**[F03] A query-embed timeout falls back to lexical silently.** `semantic/search.rs:101` and `search.rs:174` turn both the 3 s expiry and an embed error into `None` with no log line; `help.search` then returns plain results with no note, and `operator-ask` prints "search: hybrid" once at startup regardless of what each question's embed did. This is the swallowed-fault shape [L31] forbids, and it makes the eval's search-mode line untrustworthy. **(verified)**

**[F04] The helper's death reason is never seen.** `embedder.rs:56` nulls the child's stderr and the child is never waited on, so a dyld failure or a codesign refusal logs only "semantic index stays lexical". **(verified)**

**[F05] The helper runs at nice 10 on one serial queue that also serves the user's query.** `tugapp/tugembed/main.swift:189` lowers priority with a comment saying the helper "is never what the user is waiting on"; `search.rs:107` embeds the user's question through the same process under a 3 s horizon, behind whatever ingest batch is in flight. Under load the query misses its horizon and the search degrades to lexical, silently per [F03]. **(verified)**

**[F06] Two hybrid implementations exist, and the older one materializes every vector on the async thread.** `SemanticSearch::rank` (`search.rs:107`) calls `index.vectors` (`semantic/index.rs:526`), which collects every vector of a kind into memory under the shared reader mutex with no `spawn_blocking`; `passages` (`search.rs:185`) streams through `scan_vectors` on a blocking task with a connection of its own. Only `help.search` uses `rank`, over hundreds of chunks, which hides the cost. `lexical_sources` and `holds_all` are the same duplication on the lexical side. **(verified)**

**[F07] The per-query vector scan does not scale as the brief assumed.** The first brief estimated about a hundred thousand chunks and tens of milliseconds per query. On the `release-main` instance after one day the index holds 242,837 embedded vectors of 512 floats, 497 MB of blob, and a scan that reads every vector's bytes took 3.4 s cold and 0.74 s warm on a private copy, before any dot products. The file is 1.4 GB: 466 MB of vectors, 215 MB of lexical tool-output bodies, 128 MB of FTS index, the rest row and index overhead. The only query latencies in the log, 12 to 18 ms, were eval runs against the four-transcript fixture, not the live index; real cross-kind latency has never been measured. SQLite blob IO dominates, not arithmetic. **(verified by measurement; the live path itself was not timed)**

**[F08] Boot runs `quick_check` on the semantic ledger synchronously.** `index.rs:139` calls `ledger_integrity::integrity_gate`, a `PRAGMA quick_check(1)` that scales with file size, inside `boot/ledgers.rs` on the startup path. The other ledgers do the same, and they are small. **(verified)**

**[F09] Both embedders are pinned to English in the helper, not by the model.** `main.swift:54` passes `language: .english` to `embeddingResult(for:language:)`, `main.swift:143` constructs `NLContextualEmbedding(language: .english)`, and `main.swift:76` loads `NLEmbedding.sentenceEmbedding(for: .english)`. The contextual model the OS loaded for English reported 20 languages in the first brief's probe, so the model is multilingual and the pin is a hint the helper supplies for every passage. The static sentence model is one model per language. The model tag `nl-contextual-en-r1` carries the pinned language in its name. **(verified; the behaviour of a non-English passage under the pin was not measured)**

**[F10] A help ref chip carries no annotation contract, so it gets no link affordance.** `tugdeck/src/components/overview/overview-card.tsx:470` renders a help chip as a `span` stamped with `data-overview-ref-kind` and `data-overview-ref-target` and nothing else; the other ref kinds go through `annotationProps` at line 303, which adds `className: ANNOTATION_CLASS` and `data-tug-annotation`. `tugdeck/styles/tug-annotation.css:41` declares the underline at rest and the full link treatment on hover for `.tugx-annotation[data-tug-annotation]` only, and `tug-atom-ref.css` says plainly that it declares no affordance of its own for that reason. So a help chip has no underline at rest and none on hover. **(verified, read from the code; matches the user's screenshot)**

**[F11] A help card opened from a ref lands with its masthead above the viewport and its bottom out of line with its neighbours.** The user's screenshot shows the feature guide opened beside a session card with its title bar off the top of the window and its lower edge not aligned with the session card's. `help-card.tsx:375` registers a preferred height of 720 px and a minimum of 320 px. The commit card is opened by the same shape of code (`open-commit-in-card.ts:113` and `open-help-in-card.ts:117` both call `addCard` with an origin). **(observed; the cause is not found)**

**[F12] Un-marking a session private never re-indexes it until restart.** `agent_supervisor/control/rows.rs:384` removes chunks on `private = true`; nothing is owed on `private = false`, and the catch-up scan runs once per process. A test records "going public again does not bring them back" as intended. **(verified)**

**[F13] The facility has no design decision.** `tuglaws/design-decisions.md` gained nothing across the three arcs; the one paragraph in `CLAUDE.md` and the three briefs are the only account of why Apple's models, why one ledger per instance, why brute force, why hybrid, and why the index is an aid and never a dependency. **(verified)**

**[F14] Smaller weaknesses, each verified:** the whole transcript is read into memory with no size cap (`transcript.rs:233`, about 300 MB resident for the 123 MB file, where documents have `MAX_DOCUMENT_BYTES`); the retrieve prompt's heading lists are hand-maintained literal text of about 21 KB whose drift tests run only in a checkout build (`feeds/overview_agent.rs:394`); the eval's "retrieved" check is a substring test over all round output so a session id in a roster listing counts (`scripts/operator-eval.ts:259`), and nothing checks that `tests/operator-eval/history-questions.json` names fixture ids that exist; a tool-result label differs across a cursor boundary so the same block re-embeds (`transcript.rs:284`); removal of sessions the listing no longer holds waits for the catch-up queue to drain (`transcript.rs:801`); `the_schema_holds_what_the_brief_names` in `tugsem-core/src/store.rs:166` asserts substrings of a constant and so asserts nothing.

---

## Decisions {#decisions}

**[B01] The six defects are fixed as the arc's first work, each in the smallest change that ends it.** A join error pops the job like an IO error [F01]. `start` refuses to respawn before a backoff seeded from the death count, and the enshrining test is rewritten to assert the backoff [F02]. The first query-embed timeout or error per process logs a warning, and every hybrid-capable verb's result carries whether it ranked by meaning, which `operator-ask` prints per question [F03]. The helper's stderr is piped to tracing and its exit status read on death [F04]. The nice call is removed [F05]; a second lane for queries is not built until a measurement says the serial queue still costs the user. `rank`, `index.vectors`, `lexical_sources` and `holds_all` are deleted and `help.search` goes through `passages` with the help kind [F06].

**[B02] Vectors are stored quantized to eight bits and compared from an in-memory arena per model, loaded once and kept current by the writer.** [F07] says the brute-force decision was right in kind and wrong in medium: the cost is reading half a gigabyte of blobs from SQLite per question, and that grows with every session. Eight-bit quantization cuts the stored vectors to about 125 MB and leaves cosine ranking essentially unchanged at this scale; holding them in memory removes the file read from the query entirely, so a scan is tens of milliseconds of arithmetic on a blocking task. The arena is rebuilt from the ledger at open and updated by `replace_source`, `replace_vectors` and the removals, so it never disagrees with the file. The schema version bumps and a migration re-encodes the blobs; the store's comment says why. The scan logs its wall time and its count, so the next sizing claim is a measurement. The lexical rows of tool output are left as they are: the brief accepted the file size for them and they are not read per query.

**[B03] The integrity probe on `semantic.db` moves off the startup path.** [F08]. The ledger opens without the gate; a read-only probe runs on a blocking task after boot and, on a corruption verdict, tugcast drops the index, quarantines the file by rename as the gate does today, and reopens empty so the catch-up rebuilds it. The index is the one ledger whose loss costs nothing but time, which is what makes an asynchronous verdict safe here and nowhere else. The other ledgers keep the synchronous gate.

**[B04] The helper detects each passage's language and passes it, instead of pinning English.** [F09]. The contextual model is multilingual, so the fix is to stop telling it every passage is English: `NLLanguageRecognizer` names the dominant language of a text and the helper passes that, or nothing, to `embeddingResult`. The static fallback is one model per language, so it is loaded for the detected language and cached per language. The model tag names the model and its revision and not a language, so a Spanish passage and an English one embedded by the same multilingual model share a space; a passage whose language the model does not cover is stored with no vector and found lexically, which the schema already allows. Mixed-language and non-English queries are added to the eval set so the change is measured, not assumed.

**[B05] Help ref chips join the annotation contract.** [F10]. The chip stamps `ANNOTATION_CLASS` and a `data-tug-annotation` kind beside the overview-ref attributes it already carries, so `tug-annotation.css` gives it the same underline at rest and link treatment on hover every other confirmed ref has. Nothing is declared in `tug-atom-ref.css`, for the reason that file gives. The help kind joins whatever census the annotation reader keeps so a click still goes to `requestHelpCard`.

**[B06] A card opened from a help ref lands with its masthead on screen and its edges on its neighbours' lines; the arc finds the cause before it fixes it.** [F11]. The first step reproduces the fault in the app-test harness from a help ref click and reads where the frame's top and height came from, with the card's 720 px preferred height and the opening-placement path as the first suspects. The fix lands wherever the reading points; the test stays as the guard. If the same fault reproduces for a commit card opened from a ref, the fix is in the shared path and both are covered.

**[B07] The facility is recorded as a design decision, on all counts.** [F13]. One entry in `tuglaws/design-decisions.md` says: embeddings come from Apple's on-device NaturalLanguage models and from nowhere else, and why every other route was refused; the index is one ledger per instance and why; retrieval is hybrid, BM25 and cosine fused by reciprocal rank, and why neither alone; similarity is brute force over an in-memory quantized arena, with the file-scan correction this brief makes and the measurement that forced it; the index is an aid and never a dependency, rebuildable from its sources, quarantined rather than repaired; private sessions are excluded at ingest; the Observer never reads it and a user's question does. It cites the three briefs and this one.

**[B08] The smaller weaknesses land in the same arc where they are a few lines, and are named where they are not.** [F14]. A transcript size cap beside the document one; a fixture-existence test for the history eval set and a "retrieved" test that looks at the verb's own rows rather than all round output; the label carried across a cursor boundary; the empty schema test deleted. The heading lists stay hand-maintained for now, since generating them at pool build changes the prompt-assembly path and belongs to its own decision; the reconcile-on-drain order stays, since it is right once the catch-up has finished.

**[B09] Private-to-public re-indexing is not done now.** [F12]. The user's call: "not critical now." The test that documents the gap stays, with its comment saying this is deferred rather than intended.

---

## Open Questions {#open-questions}

- **Eight-bit quantization's effect on ranking at this corpus.** The literature and the recorded vectors say it is negligible at 512 dimensions, but the eval set is what says so here. The arc runs the help and history evals before and after [B02] and keeps the before numbers in the arc log.
- **Whether a serial helper still costs the user once the nice call is gone.** [B01] removes the priority drop and does not build a second lane. A measurement of query embed time under a running catch-up decides whether a lane is owed.

---

## Non-goals {#non-goals}

- **An approximate nearest-neighbour index.** Not needed at hundreds of thousands of vectors once the scan is in memory [B02]; revisit at millions.
- **A vector database or SQLite vector extension.** The first brief's reasons stand.
- **Re-indexing a session that goes public again.** Deferred by the user [B09].
- **Generating the prompt's heading lists at pool build.** Named, not done [B08].
- **Shrinking the lexical tool-output rows.** Accepted by the second brief; nothing reads them per query.
- **Private-session UI.** Still built, still not shown.

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land:

1. The six defects [B01], with the enshrining tests rewritten to assert the new behaviour, and the eval's per-question search-mode marker.
2. Help ref chips on the annotation contract [B05], and the reproduction of the off-screen masthead in the harness, then its fix [B06].
3. The language detection and the model tag [B04], with non-English questions added to the eval set.
4. Quantized vectors and the in-memory arena [B02], with the schema migration, the scan's timing line, and the eval run before and after.
5. The asynchronous integrity probe [B03].
6. The smaller weaknesses [B08] and the design decision [B07], written in the same round as the last code change so it describes what landed.
