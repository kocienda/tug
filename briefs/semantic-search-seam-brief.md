# Semantic search seam: on-device embeddings, a hybrid index, and an expert help search

**Purpose:** The Overview's Operator cannot find the help passage that answers "how do I create an arc", because its only search is a substring match over two documents, and nothing in Tug can rank content by meaning. Tug needs one semantic search facility that chunks, embeds, stores, queries and reassembles content, built on the embedding models macOS already ships, with the help documents as its first stream and the Operator upgraded to Sonnet.

---

## Purpose {#purpose}

The user asked the Overview "how do I create an arc?" and got an answer that spent its longest paragraph on what the documents did not settle, even though `docs/features.md` has an "Opening an arc" section that answers the question exactly. Their verdict: "we need to do *way better*. The overview must be an *expert* in how Tug works!"

The wider want, in the user's words: "having some sort of content-based embeddings feature available in Tug seems like *it would really help*", but every obvious route was blocked. Anthropic offers no embedding model on the account Claude Code is logged into. Bundling a local model is "a *huge* increase in download size and memory impact". Any hosted service means Tug's provider eats the cost or the user has to hold yet another paid account. "We have a Gordian knot here. How do we cut it?"

The cut is that the model is already on every Mac Tug runs on. This brief is the first of three: it builds the facility and proves it on the help documents. The second brings transcripts, Observer content and project documents into the index. The third writes the help content the index makes room for.

---

## Evidence {#evidence}

**[F01] Apple ships two on-device sentence embedders, both older than Tug's minimum macOS.** The SDK headers on this machine mark `NLEmbedding.sentenceEmbedding(for:)` as `macos(11.0)` and `NLContextualEmbedding` as `NS_CLASS_AVAILABLE(14_0, 17_0)`. Tug's `LSMinimumSystemVersion` in `tugapp/Info.plist` is 15.0. Neither needs the current OS, and neither adds a byte to the bundle. **(verified)**

**[F02] The static model ranks the failing query correctly with no index at all.** A Swift probe compiled on this machine embedded "how do I create an arc?" against seven candidate titles with `NLEmbedding.sentenceEmbedding(for: .english)` (512 dimensions, revision 1). "Door — the one skill that opens the arc lane" scored 0.409 and "Opening an arc" 0.380; "The join" 0.258, "Base" 0.178, "Sidebar cards" 0.128. Those last three are exactly the hits the current search returned for "new arc" in the earlier session. **(verified)**

**[F03] The contextual model agrees on the top two, is fast, and had its assets already present.** `NLContextualEmbedding(language: .english)` reported 512 dimensions, 20 languages, a 256-token maximum sequence, and `hasAvailableAssets` true before `requestAssets` was called. Mean-pooled token vectors put "Opening an arc" at 0.858 and "Door" at 0.856, but compressed every candidate into 0.58–0.86, so a relevance threshold on it needs calibrating against real queries. Eight embeddings took 53 ms. **(verified)**

**[F04] The current help search is substring-and-stopword with a six-hit cap broken by document order.** `search_terms` in `tugrust/crates/tugcast/src/help_docs.rs` lowercases, splits on non-alphanumerics, drops question words, and `holds` matches a substring or a stripped plural. `HELP_SEARCH_LIMIT` is 6 in `feeds/operator.rs`. Eleven units carry "arc" in their title and the glossary is read first, so an unscoped search for "arc" returns six glossary entries and never reaches the guide section. **(verified, read from the code and reproduced in the earlier session)**

**[F05] The Operator runs on Haiku by a constant, and the pool is named for the model.** `HAIKU_MODEL` is `"claude-haiku-4-5"` in `tugrust/crates/tugcast/src/shared_agent.rs`; `boot/supervisor.rs` and `feeds/operator_ask.rs` fall back to it; `OperatorContext` carries the pool as a field named `haiku`. **(verified)**

**[F06] The retrieve prompt inlines the glossary's terms but not the feature guide's headings.** `OPERATOR_RETRIEVE_INSTRUCTIONS` in `feeds/overview_agent.rs` ends its help paragraph with "The glossary's terms are:" and a generated list; a test asserts the list is present. The 34 guide headings are not on the page, so the model has to guess a search word to reach "Opening an arc" instead of naming it to `help.read`. **(verified)**

**[F07] tugcast already has the storage and search machinery the facility needs beside it.** `rusqlite` is bundled (workspace `0.33`, `features = ["bundled"]`) and FTS5 is in use for `facts_fts` and `overview_posts_fts` in `session_ledger.rs`. Every writable ledger opens through `tugcore::ledger_db` with a `PRAGMA user_version` migration list. `feeds/secret_filter.rs` already scrubs content before the Observer sees it. `is_session_private` and `refuse_if_private` exist in the ledger and the Operator. **(verified)**

**[F08] tugcast already spawns and supervises long-lived helper processes over line protocols.** `ClaudeAgentWorkerSpawner` in `shared_agent.rs` spawns a `claude` worker and speaks to it over stdin/stdout; `control.rs` carries a request/reply line to the host app over a Unix domain socket. The bundle's `Contents/MacOS/` holds six helper binaries beside `Tug`, copied from `tugrust/target/release/` by the Xcode copy phase that `tugrust/scripts/build-release-inputs.sh` feeds. No bundled binary is built with `swiftc` today. **(verified)**

**[F09] The `operator-ask` instrument exists and the two runs it made disagreed.** `tugcast operator-ask` (in `cli.rs` and `feeds/operator_ask.rs`) drives the real two-round Operator against a ledger fixture from the command line. In the earlier session two runs of the same question chose different verbs and produced different answers. There is no fixed question set, so today an improvement is felt rather than measured. **(verified)**

---

## Decisions {#decisions}

**[B01] Tug's embeddings come from Apple's NaturalLanguage framework, on device, and from nowhere else.** This is the one route that satisfies every constraint at once: no account, no provider cost, no model bytes in the bundle, no network, no GPL, and it works offline. It is macOS-only, which Tug is. Quality is below the hosted embedders, but the task is retrieval over a few hundred thousand short passages of the user's own prose, where a decent small model fused with lexical search is plenty. Revisit only if Anthropic ships an embedding model on the Claude Code account.

**[B02] The embedder is a Swift helper binary, `tugembed`, in `Contents/MacOS/`, spawned once by tugcast and spoken to over JSON lines on stdin and stdout.** A helper rather than the control socket, because embedding is CPU work that must never ride the app's main process, and because headless tugcast, the `operator-ask` instrument, and the Rust and app-test suites all need embeddings with no Tug.app running. A batch of strings goes in; vectors come out, each tagged with the model that produced it. The helper is built with `swiftc` by `build-release-inputs.sh` and copied like the Rust binaries, which is the first non-Rust helper in the bundle and the one new build shape this brief introduces.

**[B03] `tugembed` uses `NLContextualEmbedding` with mean pooling and falls back to `NLEmbedding.sentenceEmbedding` when the contextual assets are absent.** The contextual model is the better one [F03]; the static one needs no asset request [F02]. The helper calls `requestAssets` once at start and reports which model is live. A vector's model is stored with it, and a query only compares vectors from the same model, so a machine whose assets arrive later re-embeds rather than mixing spaces.

**[B04] The facility is one seam, `tugsem-core`, a Rust crate with no IO: chunking, store schema, scoring, fusion and reassembly.** An embed-only seam would leave every caller to chunk, store and rank for itself, and there will be at least three callers across these briefs. Callers submit a source and ask a question; the crate decides passages, ranks, and hands back readable spans with refs. Everything that touches a clock, a process or a database lives in tugcast, in the same pattern `facts_library.rs` sets.

**[B05] The chunker splits under the model's 256-token cap at paragraph and sentence boundaries, prefixes each passage with one line of context, and overlaps neighbours slightly.** The context line is the document title and heading for a help unit, and will be the session callsign and turn role for a transcript turn. Help documents chunk along the units `help_docs.rs` already produces, so a hit's anchor is the anchor the help card opens at. Every passage passes `secret_filter` before it is embedded.

**[B06] The index is one SQLite ledger per instance, `semantic.db`, opened through `tugcore::ledger_db` with a registered migration list; tugcast is the only writer; `TUG_SEMANTIC_DB` redirects it for test isolation.** Per instance, matching `sessions.db`, because a cross-instance index would only ever matter to Tug's own developers, who are not who this is built for. A chunks table holds source kind, source id, span, model, text and the 512-float vector as a blob, with an FTS5 shadow of the text. Retention follows the source: a source removed from Tug removes its chunks. Any harness that spawns tugcast sets the variable, beside `TUG_SESSION_INDEX_DB` and `TUG_REPORT_GAPS_DB`.

**[B07] Similarity is brute-force cosine in Rust; no vector extension and no new dependency.** At 512 dimensions a hundred thousand chunks is about fifty million multiply-adds, tens of milliseconds on this hardware. An approximate index earns its place at millions of chunks, which no instance will reach in this program. Quantizing the blob to eight bits is the first move if the file size ever matters, and it changes the store, not the seam.

**[B08] Every query is hybrid: FTS5 BM25 and cosine both run and the ranks are fused by reciprocal rank.** Embeddings are weak on exact tokens, and a Tug question is full of them: a sha, an `at0339`, a flag, a path. Lexical search is weak on meaning, which is the failure in [F04]. Fusion is the standard answer and costs one extra query. `help.search` becomes this hybrid underneath without changing its result shape, so the help card and the ref validator see what they see today.

**[B09] The feature guide's headings join the glossary's terms in the retrieve prompt.** Cheapest change with the largest effect [F06]: with the map on the page the model names "Opening an arc" to `help.read` instead of guessing a search word. The list is generated the way the glossary list is, and the same test covers it.

**[B10] The Operator runs on Sonnet, and the constant and the pool field are renamed to be model-neutral.** An expert on Tug is worth a slower turn. Sonnet is slower per round and the Operator runs two rounds, so an answer that took four seconds will take closer to ten; that is the trade. The field named `haiku` and the constant `HAIKU_MODEL` become a name that says what the pool is for, so the next upgrade is not also a rename. This lands first and alone, because it is independent of everything else here.

**[B11] A fixed eval set of twenty to thirty app questions with expected help refs runs through `tugcast operator-ask` against a ledger fixture, and it is the acceptance test for this brief and the next two.** Today improvement is felt [F09]. The set names, for each question, the help anchor the answer must rest on; a run reports how many answers cited it. The set grows as the third brief's content lands, and it is what says where the model still chooses badly.

**[B12] Private sessions are excluded at ingest, not at query time, and the control is built but not exposed in the UI yet.** Text that is never in the index cannot leak through a new verb. The ledger's `private` column is the signal; marking a session private removes its chunks, and the Operator's existing `refuse_if_private` stays as the second wall. No new UI in this program; the user will decide when to surface it.

**[B13] The Observer's wake window is not changed by this brief.** The index serves the Operator's answers to the user's questions. Whether a wake should carry a "related history" section is the second brief's decision, once there is history in the index to relate.

---

## Open Questions {#open-questions}

- **Relevance threshold on the contextual model.** [F03] shows its scores compressed into a narrow band. The eval set [B11] is what settles where the cut-off sits, and whether the fused rank makes a threshold unnecessary. It cannot be settled before the index exists.
- **Signing and notarization of a `swiftc`-built helper.** `sign-bundle.sh` signs the Rust binaries today. A Swift binary with the NaturalLanguage framework linked should sign the same way, but it is the first of its kind in the bundle [F08] and the first arc step that builds it must confirm the Release bundle launches it under the hardened runtime.

---

## Non-goals {#non-goals}

- **A hosted embedding service.** Anthropic offers none on the user's account; any other provider means Tug's provider pays or the user holds another paid login. Rejected on the user's constraints, not on quality.
- **A bundled local model.** Download size and memory impact the user called "huge". The OS already carries one.
- **A vector database or SQLite vector extension.** Brute-force cosine is fast enough at every size this program reaches [B07], and a new dependency with its own licence and build is not worth tens of milliseconds.
- **A purely semantic search.** Exact tokens matter too much in a developer tool [B08].
- **Transcript, Observer and project document streams.** The second brief. This one proves the pipeline on the smallest corpus.
- **New help content.** The third brief. This one makes the content findable; it does not write it.
- **An LLM-as-reranker over the user's account.** It is what the Operator already does when it reads search results, and it is the slow part. The index exists so the model reads fewer, better passages.
- **Exposing private-session controls in the UI.** Built, not shown [B12].

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land:

1. Sonnet: the constant and the rename [B10], with the existing Operator tests passing on the new name. Alone, first.
2. `tugembed`: the Swift helper, its JSON-lines protocol, the model fallback [B02][B03], built and copied into the bundle, with a signed Release bundle launching it.
3. `tugsem-core`: chunker, store schema, cosine, fusion, reassembly [B04][B05][B07][B08], tested on recorded passages with no process or database.
4. `semantic.db` in tugcast: the ledger, its migration list, the writer, `TUG_SEMANTIC_DB` [B06], and the help-docs stream indexed at start.
5. Hybrid `help.search` and the headings in the retrieve prompt [B08][B09].
6. The eval set over `operator-ask` [B11], run before step 5 for a baseline and after it for the verdict.
