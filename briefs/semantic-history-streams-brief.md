# Semantic history: transcripts, Observer content and project documents in the index

**Purpose:** Once the semantic search seam exists, the Overview should be able to answer questions about everything that has passed through Tug: every transcript, every settled fact and post, and the briefs and laws of the open project. Today it can reach those only by exact-word search and a two-turn transcript read. This brief brings the three remaining streams into `semantic.db`, as a background catch-up that takes as long as it takes, and exposes the result to the Operator.

---

## Purpose {#purpose}

The user, on what a working index would make possible: "we could *substantially expand* the amount of help documentation available, and embed *all* the content that traverses the Overview via the Observer and *all* the content in the transcripts so that questions the user asks in the Overview are *covered* in a way they simply aren't now."

And on the cost of indexing everything already on disk: "Let's incur the one-time cost for me. Nobody else will really be affected here... That said, we should design this as a background/catch-up process. It takes as long as it takes to bring all the content online and provide full semantic search coverage, but that's OK."

This is the second of three briefs. The first, `briefs/semantic-search-seam-brief.md`, builds the facility and proves it on the help documents; its decisions `[B01]`–`[B13]` are assumed here and not restated. The third writes the help content.

---

## Evidence {#evidence}

**[F01] The transcript corpus is large and most of it is tool output.** Claude Code's project directory for this checkout holds 1,074 JSONL files totalling 2.5 GB. The largest single transcript is 123 MB and carries 7,069 user records, 6,400 `tool_use`/`tool_result` pairs and 2,525 assistant text blocks. The prose a person would ask about is a small fraction of the bytes; the tool results are the bulk. **(verified, counted on this machine)**

**[F02] The live ledger is small by comparison and already text-shaped.** The `release-main` instance's `sessions.db` holds 299 sessions, 58,789 facts and 4,813 Overview posts, with zero sessions marked private. Facts and posts are stored as the one rendered sentence `facts_library::render_text` produces, which is what their FTS5 indexes already cover. **(verified via `just db-inspect`)**

**[F03] tugcast already parses transcripts two ways and holds rendered text for every live message.** `turn_engine::segment_str` segments a JSONL file into turns and carries a `Frontier` across incremental appends, so a growing file is read from where it left off. `overview_replay::translate_transcript` turns the same JSONL into Observer frames. `RenderStage` keeps `tugmark::rendered_text` for every assistant Message it has seen, live or replayed, which is what `find_index` searches. **(verified)**

**[F04] The Observer's digest lines are not persisted.** The per-session window in `feeds/observer.rs` holds `DigestLine`s in memory; only the facts and posts they lead to reach the ledger. What "traverses the Observer" and survives is therefore facts, posts, and the transcripts the digest was derived from. **(verified, no digest table in `session_ledger.rs`)**

**[F05] The project already declares its prose.** `.tugtool/config.toml` carries a `[[tugtool.arc.surface]]` named `prose` whose `paths` list `tuglaws/`, `briefs/`, `release-notes/`, `CLAUDE.md` and the other top-level documents, and `tugtool brief dir` reports the Briefs Directory setting. Both are readable by tugtool and tugcast today. **(verified)**

**[F06] Private sessions and trashed sessions already have one ledger signal each.** `sessions.private` is a column with a self-healing migration, `is_session_private` reads it, and `trash_external_jsonl` is the one door a transcript leaves through. **(verified)**

**[F07] The Operator's existing searches are lexical and session-scoped.** `facts.search` runs over `facts_fts`; `session.transcript` reads one session by last-N turns, by turn, or by grep. There is no verb that asks a question across every session, and `refuse_if_private` guards the per-session verbs by name. **(verified)**

---

## Decisions {#decisions}

**[B01] Three streams join the index: transcripts, Observer content, and project documents.** Transcripts are the user's and the model's prose over every session. Observer content is the facts and posts, which are already sentences with refs. Project documents are the briefs directory and the prose surface the project declares. Together they are what the user meant by "all the content"; nothing else in Tug holds text a person would ask about.

**[B02] Transcript chunks are passages of prose, with tool results reduced before embedding.** User text and assistant text blocks chunk under the seam's rules with a context line of session callsign, turn index and role. A tool result keeps its head, its tail and any line that reads as a failure or a verdict, embedded as one passage that names the command; the body of a long log is indexed lexically only. [F01] says this is where the bytes are, and a thousand lines of test output embedded whole is noise that costs minutes. Thinking blocks are not indexed.

**[B03] Transcripts are read from Claude Code's JSONL through the segmenter tugcast already has, live and in backfill.** The live path follows the `Frontier` [F03]: when a turn settles, its new records are chunked and embedded. The backfill walks every JSONL the ledger knows for the instance's projects from the oldest, through the same code, so live and historical chunks are the same shape and a replayed session indexes identically to a live one. No second parser.

**[B04] Facts and posts are indexed as they are written, from the rendered text they are stored as.** One rendering per fact is already the rule [F02]; the chunk is that sentence with its kind and session as context, and its ref is the fact's own handle. Observer digest lines are not indexed, because they are not persisted [F04] and the transcript they came from is.

**[B05] Project documents are indexed from a declared list, re-indexed on change, and the default list is the Briefs Directory plus the project's prose surface.** A `[tugtool.semantic]` table in `.tugtool/config.toml` names the document paths; absent one, tugcast indexes the briefs directory and every path the `prose` surface lists [F05]. Markdown chunks along headings with the file path and heading as context, so a hit's ref opens the file at the line. Changes are seen through the directory watch tugcast already runs for open files, extended to these directories. For a project with none of this, the stream is empty and costs nothing.

**[B06] Backfill is a background catch-up with a cursor, lowest priority, that runs until the index is complete and then stays current.** It starts when tugcast does, walks sources oldest first, yields to live ingestion, and records its position per source so a restart resumes rather than repeats. It reports progress as one line the Overview can show. At roughly 7 ms per passage [first brief F03], a 2.5 GB corpus reduced per [B02] is hours, not days, and it is paid once on this one machine. Nothing in the user's experience waits on it: a question asked mid-backfill is answered from what is indexed so far, and the answer says the index is still catching up.

**[B07] Index coverage follows the source's life.** A session marked private has its chunks deleted and its JSONL skipped; a session trashed through `trash_external_jsonl` loses its chunks; a project document deleted or moved out of the list loses its chunks on the next watch event. There is no retention policy of the index's own, because every chunk's lifetime is already defined by the thing it was cut from.

**[B08] The Operator gets one new verb, `search.semantic`, and the existing searches become hybrid underneath.** The verb takes a query, an optional kind (`help`, `transcript`, `fact`, `post`, `document`), an optional session, and a limit, and returns reassembled passages best first with refs the validator already knows. `facts.search` and `session.transcript`'s grep run the fused rank over their existing scope with their result shapes unchanged. The retrieve prompt says when to reach for the cross-session verb: when the question is about something that happened rather than something in the code or the help.

**[B09] A user question's wake carries a short "related history" section; an ordinary Observer wake does not.** When the user asks the Overview a question, the top few semantic hits across streams are placed in the window beside the question, so round one can read them without a verb call. A wake the Observer raises on its own gets nothing from the index: the index must never change what the Overview volunteers, only what it can answer. This settles the first brief's `[B13]`.

**[B10] Private-session exclusion is complete across the three streams and remains unexposed in the UI.** The signal is the one column [F06]; the behaviour is [B07]; `refuse_if_private` stays on the per-session verbs and `search.semantic` filters on the same column. No new control is drawn.

---

## Open Questions {#open-questions}

- **Where backfill progress is shown.** One line in the Overview, a row in a sidebar card, or only in the log. It affects the deck, so the user chooses; the catch-up itself does not wait on the answer.
- **Rendered or raw assistant text.** `RenderStage` holds the rendered text of live messages [F03] and the backfill has only the JSONL's markdown. Chunking the markdown in both cases keeps the shapes identical [B03]; chunking rendered text reads better but would make live and backfilled chunks differ. The first arc step that chunks a transcript should measure the retrieval difference on the eval set before choosing.

---

## Non-goals {#non-goals}

- **Indexing tool output in full.** It is most of the bytes and least of the meaning [F01][B02]. Lexical coverage of the body is enough to find a sha or an error string.
- **Indexing thinking blocks.** Not something the user asked or would ask about, and not shown in the transcript.
- **Persisting Observer digest lines to index them.** The transcript already holds what they were made from [F04].
- **Changing what the Observer posts on its own.** The index answers questions; it does not generate posts [B09].
- **A machine-global or cross-instance index.** Per instance, per the first brief's `[B06]`.
- **Private-session UI.** Built, not shown [B10].
- **New help content.** The third brief.

---

## Exit {#exit}

**An arc**, opened after the first brief's arc has landed `tugsem-core` and `semantic.db`. The first steps, in the order they must land:

1. The source model: source kinds, per-source cursors, the lifetime rules [B07], and the coverage filter for private sessions [B10], in `tugsem-core` and the ledger.
2. The Observer stream [B04]: facts and posts indexed as written, with a one-time pass over the existing rows. Smallest stream, proves the live-write path.
3. The transcript chunker [B02] on recorded JSONL, measured on the eval set, settling the rendered-or-raw question.
4. Live transcript ingestion on the `Frontier`, then the background catch-up with its cursor and progress line [B03][B06].
5. The project-documents stream with its declared list and watch [B05].
6. `search.semantic`, the hybrid rewiring of the existing searches, and the related-history section on a user question [B08][B09], with the eval set extended with history questions whose expected refs are sessions and documents.
