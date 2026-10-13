<!-- brief-skeleton v1 -->

# tugcast renders: markdown, highlighting and search leave the page

**Purpose:** The last script the page still runs per streamed token after stages 1 through 3 is the markdown parse, its sanitization, the code highlighting and the text extraction behind find. All of it is pure computation over text tugcast already holds, and the markdown crate is Rust compiled to WASM. This stage runs it natively in tugcast and ships sanitized block HTML keyed by block hash, so the page's work per token is one `innerHTML` write.

Stage 5 of `briefs/main-thread-headroom-program-brief.md`; builds on stage 3's patch protocol. The program brief's [B08] says this stage may be skipped if the earlier ones read clean.

---

## Purpose {#purpose}

The user: "I mean, come on, we have a super computer here." tugcast is a Rust process on the same machine with every core the page does not have. Four sessions' markdown parsing is four cores' worth of work that today runs serially on the one thread the motion needs. The page should receive pictures of text, not text to picture.

---

## Evidence {#evidence}

**[F01] The page's markdown pipeline per streamed delta.** `parseMarkdownToSanitizedBlocks` (`tugdeck/src/lib/markdown/parse-markdown-to-sanitized-blocks.ts:242`) runs WASM `lex_blocks`, `parse_blocks_to_html` over the whole document and `lex_block_hashes`, builds a byte-to-char map over the full text, and runs DOMPurify over every block (`:274`). `renderIncrementalFromBlocks` (`render-incremental.ts:324`) then diffs block hashes and rewrites only changed blocks, running `enhanceFencedCode` and `annotateContent` on each. A streaming row misses the parse cache on every delta by design (`tug-markdown-block.tsx:352`). **(verified, read from the code)**

**[F02] The markdown crate is already Rust.** `tugdeck/crates/tugmark-wasm/Cargo.toml` depends on `pulldown-cmark 0.12` with `html` and `simd`. tugcast can depend on the same crate natively. **(verified, read from the code)**

**[F03] Sanitization is the one step that wants a DOM.** DOMPurify needs a document. `ammonia` is the Rust HTML sanitizer built for this purpose; it is not currently a dependency anywhere in `tugrust/Cargo.lock`. **(verified for the dependency; `ammonia`'s fitness is to be read by the arc against DOMPurify's configured allow-list in `dompurify-instance.ts`)**

**[F04] Highlighting is Lezer on the main thread.** `enhance-fenced-code.ts:78` calls `highlightFragmentToHtml` (`language-registry.ts:595`); the grammar loads lazily, the highlighting runs on the main thread, and a code block still streaming is re-highlighted on every frame it changes. **(verified, read from the code)**

**[F05] The find index is text extraction over the transcript.** `transcript-search-index.ts` extracts text per row by parsing to HTML and reading `textContent` from a scratch element. tugcast holds every turn's text in the session ledger. **(verified, read from the code)**

**[F06] The reconciler already keys on block hashes.** `data-content-hash` on each block container is what the incremental renderer diffs against (`tug-markdown-block.tsx` comment near `:355`; `render-incremental.ts`). A sender that ships `(hash, html)` pairs feeds the same reconciler. **(verified, read from the code)**

**[F07] The OVERVIEW feed already carries server-produced content.** tugcast's digester produces Overview posts and current lines from CODE_OUTPUT (`tugproto/src/outbound.ts:136`), so a tugcast feed that derives a rendered view from the session's wire has precedent in the architecture. **(verified, read from the code)**

**[F08] Stage 3 established a sender-agnostic patch protocol.** Stage 3 [B07]: a batch is a list of `(session, kind, payload)` patches with no sender named. A `rendered-blocks` patch kind carrying `(block hash, sanitized html)` pairs for a row fits it. **(a dependency on stage 3 landing as decided)**

---

## Decisions {#decisions}

**[B01] tugcast renders a row's markdown to sanitized block HTML and ships it as a patch.** A new tugcast stage beside the digester consumes a session's assistant text and emits, per streamed delta coalesced to the display period, the row's block list as `(hash, html)` pairs for changed blocks only. The page's reconciler applies them as it applies its own parse today. Sanitization is `ammonia` in tugcast with an allow-list derived from DOMPurify's configured one, and the page trusts the result because it comes from tugcast over the loopback socket, which already carries every other frame the page trusts.

*Reversed 2026-10-12, by the rendered-HTML second-barrier fixup to this stage:* the trust argument held for the feed's provenance and not for a parser differential between tugmark's html5ever and WebKit, so the page runs DOMPurify over every block HTML an emission carries before the store holds it (`tugdeck/src/lib/markdown/rendered-barrier.ts`, called from `CodeSessionStore.applyRendered`). It costs 0.17 ms per delta on the streaming arm, and it comes off only when tugmark has been fuzzed against WebKit and a decision to remove it is recorded here.

**[B02] The same crate renders in both places until the page's parse is retired.** `tugmark-wasm` and tugcast depend on one `tugmark` crate, so a block hash computed in either place is the same hash and a drift test can hold them equal over the stream-json catalog's captured turns. The page keeps its WASM parse for the restored transcript's first paint and for any row tugcast has not rendered, and retires it only when the readings say every path is served.

**[B03] Highlighting moves with the parse.** A Rust highlighter in tugcast (the arc chooses between `tree-sitter` grammars and `syntect` against the languages `language-registry.ts` serves) emits the same class vocabulary Lezer's theme expects, so the stylesheet is unchanged. A language tugcast cannot highlight ships unhighlighted and the page may highlight it on an idle frame, never on a streaming one.

**[B04] The find index is a tugcast query.** The transcript's text is extracted once per turn in tugcast and indexed per session; the page asks for matches over the loaded window and receives row and range offsets. The page-side builder from stage 1 [B05] is retired when the query serves every case it did.

**[B05] tugcast paces and holds at the source.** tugcast coalesces each session's rendered patches to the display period and bundles every session's into one message, so stage 3's Worker receives one message per frame. The Worker's `motion-open` and `motion-closed` are forwarded to tugcast as a control frame, and tugcast buffers patches while a motion is open, with the same cap. The hold now lives two processes away from the page.

**[B06] Byte-to-char mapping and annotation stay where their consumers are.** Annotation (`annotateContent`) reads the page's own atom registry and portal hosts, and stays on the page; it runs on changed blocks only, as today. The byte-to-char map exists for annotation offsets and is emitted by tugcast with the block when it is needed, as data.

**[B07] The reading of record is stage 1's streaming arm and `tugtool deck motion rest` under streaming.** What this stage moves is the page's script time per streamed frame, which stages 1 through 3 should have reduced to the parse and the apply; after this stage it is the apply alone. Correctness is read by the drift test in [B02] over the catalog and by the transcript fidelity suite (`briefs/transcript-copy-markdown-fidelity-brief.md`'s tests) unchanged.

---

## Open Questions {#open-questions}

- **Does `ammonia` reproduce DOMPurify's allow-list exactly, including the `data-` attributes the atoms rely on?** Read by the arc against `dompurify-instance.ts`; a difference is a decision to make there, not a drift to tolerate.
- **Can pulldown-cmark render a changed tail only?** It parses the whole document. Block boundaries are stable above the streaming tail, so rendering from the last stable block boundary is the likely cut; whether the crate exposes enough to do it, or the hash diff makes it unnecessary at tugcast's speed, is the arc's first measurement.
- **Does the wire grow?** HTML is larger than markdown. Changed blocks only, over loopback, is expected to be small; the arc measures bytes per second on a four-session stream before deciding whether compression matters.
- **Is this stage wanted at all?** The program brief's [B08]: if stages 1 through 4 read clean on the user's deck under streaming, this stage is a choice, and the user makes it.

---

## Non-goals {#non-goals}

- **Rendering the Overview or any other card's chrome in tugcast.** Only row content that is pure over text moves.
- **A second sanitizer configuration.** One allow-list, derived, with a test holding the two equal while both exist.
- **Changing what the transcript looks like.** The drift test is the bar: same blocks, same hashes, same text.
- **Rendering in the Worker as an intermediate step.** It would need its own sanitizer answer and would be replaced by this stage; the program brief's [B08] names this stage as the deep form.

---

## Exit {#exit}

**An arc, if the program continues past stage 4.** The shape: the shared `tugmark` crate and the hash drift test over the catalog; `ammonia` with the derived allow-list and its equality test; the `rendered-blocks` patch kind in tugproto; tugcast's render stage with pacing and the forwarded hold; the page's reconciler fed from the patch with its WASM parse kept as fallback; highlighting; the find query; retirement of the page-side parse and index when the readings allow. The arc joins with the user's deck read under streaming and written into the program brief's record.
