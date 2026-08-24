<!-- devise-skeleton v4 -->

## Gazette Errata: Transcript-Parity Rendering, Session Citations, and Scrollback {#gazette-errata}

**Purpose:** Bring the Gazette card's post rendering to parity with the Session card transcript — real markdown bodies, transcript-grade copy, inline session citations, correctly placed provenance atoms — and fix the tugcast-side post-shaping defects (missing Operator session stamps, mid-sentence truncation, machine-values-in-prose) plus add history scrollback beyond the 50-row tail.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-12 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Gazette card (`tugdeck/src/components/gazette/gazette-card.tsx`) renders Reporter/Operator/user posts as a transcript, and after the ref-annotation work (commit `e6b61a0da`) its prose is scanned by the app's content annotator. But an errata review against the Session card transcript found ten deficiencies. The load-bearing ones: post bodies render as a raw `<p>` with `white-space: pre-wrap` instead of through the markdown pipeline, so backticked names show literal backticks and code spans / bold / lists / bare URLs never render; the unmentioned-refs provenance strip renders *below* the Z1B end-state row instead of above it, at the end of the content; session-identity references in prose (full UUIDs, `project/callsign` spellings) are dead text because no session annotation kind exists anywhere in the app; Operator posts never carry `session_id`, so the header-trailing citation Reporter posts get never appears on Operator rows; copy has no markdown resolver; the Reporter's 200-character prose clamp cuts mid-sentence; the Operator writes epoch-millisecond timestamps and raw UUIDs into prose; and history is a fixed 50-row window with no way to read older posts.

The stated design (the user's repeated ask): file and commit atoms are made **out of the content** of Reporter posts, parsed and displayed exactly as the Session transcript does it; refs the prose never names go at the **end of the content, above the Z1B**, never dangling after it.

#### Strategy {#strategy}

- Reuse, never rebuild: the Session transcript's own primitives do almost all of this. `TugMarkdownBlock` (static `initialText` mode) brings the pulldown-cmark→DOMPurify→`renderIncremental` pipeline, whose enhancer chain already runs `annotateContent` — inline-`<code>` classification, path/sha scanning, and bare-URL linkification arrive in one move. `selectionToTranscriptMarkdown` + `useTranscriptCellMenu`'s `resolveCopyMarkdown` bring two-flavor copy. `GitLogStore`'s offset/`has_more`/`loadMore` shape is the model for scrollback.
- Frontend first (markdown, copy, ref-strip placement), because the session-citation work builds on the markdown DOM; then the annotator's new session kind; then the tugcast-side fixes (Operator stamping, instruction wording, clamp backstop); scrollback last since it spans protocol + ledger + store + UI.
- The session-identity kind is app-wide annotator machinery (detection + resolution via the existing `session-citation-store`), adopted by the Gazette first and by the Session transcript's annotation context in the same plan — parity cuts both ways.
- Instruction changes fix the truncation and prose-hygiene problems at the source (the model), with the Rust clamp retained purely as a backstop that itself respects sentence boundaries.
- Every step lands with the existing app-test vehicle (`tests/app-test/at0365-gazette-card.test.ts`) extended, or Rust tests in the touched crate; selection stays `just app-test-changed`-derived.

#### Success Criteria (Measurable) {#success-criteria}

- A Reporter post body containing `` `gazette-body-segments.ts` `` renders a styled `<code>` span with no visible backticks, and that span is annotated (clickable, `data-tug-annotation` stamped) — asserted by app-test.
- A post body containing a bare `https://` URL renders a real `<a>` anchor (app-test).
- The unmentioned-refs strip renders in the DOM *before* the Z1B row within the entry, and visually between body and Z1B (app-test DOM-order assertion).
- Selecting rendered bold/code text in a post and copying yields markdown source (`**bold**`, backticked code) in `text/plain` plus a `text/html` flavor (app-test via the `gallery-transcript-copy` pattern or direct assertion on the Gazette cell).
- A prose mention of a real session — a full UUID or `project/callsign` pair whose callsign half the ledger resolves — renders as a live `TugSessionCitation` chip in place; an unresolvable look-alike token stays plain text (app-test).
- An Operator answer resting on exactly one session ref *that the ledger holds* carries that session in `session_id` on the wire, and the Gazette renders it as the header-trailing citation (Rust test + app-test); a model-invented session target stamps nothing ([P07]).
- `REPORTER_POST_INSTRUCTIONS` demands complete sentences within the 200-character prose budget and invites backticks around exact names, and `clamp_post_body` cuts at a sentence boundary when it fires without mistaking `e.g.` or a trailing `main.rs.` for one (Rust tests pin all three).
- `OPERATOR_ANSWER_INSTRUCTIONS` forbids raw epoch-milliseconds and bare UUIDs in prose (Rust test pins the strings).
- Scrolling to the top of a Gazette with more history loads an older page, prepends it without the viewport jumping, stops when `has_more` is false, and never accumulates past `GAZETTE_MAX_ROWS` (store unit tests + Rust ledger tests; the rendered prepend driven through the new `publishGazettePostsPage` test-surface verb, [Q02]).
- `cd tugrust && cargo nextest run` green; `cd tugdeck && bunx vite build` clean; `just app-test-changed` green.

#### Scope {#scope}

1. Markdown rendering for all Gazette post bodies (errata items 1, 9).
2. Markdown-fidelity copy for Gazette cells (item 5).
3. Provenance strip placement above Z1B (item 2).
4. Session-identity annotation kind: detection, resolution, citation rendering; adopted in Gazette and Session transcript (item 3).
5. Operator `session_id` stamping (item 4).
6. Reporter complete-sentence instructions + sentence-boundary clamp backstop (item 6), and the backtick authoring rule the renderer earns ([P11]).
7. Operator prose hygiene instructions (item 7).
8. Gazette history scrollback: paged `list_gazette_posts`, store paging with response correlation, scroll-top gesture, accumulation ceiling (item 8).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Find integration (errata item 10): marking Gazette markdown `findable` requires a matching search-index projection (`tugdeck/src/lib/transcript-search-index.ts`); marking without one breaks the count↔paint alignment (`TugMarkdownBlock`'s own `findable` prop doc says exactly this). Deferred to its own plan; every `TugMarkdownBlock` mounted by this plan passes `findable={false}` (the default).
- Streaming Gazette bodies. Posts arrive whole; static `initialText` mode is correct. No `streamingStore` wiring.
- A slash-command catalog for Gazette annotation. `useGazetteAnnotation` keeps `isKnownSlashCommand: () => false` — with no live session there is no authoritative catalog.
- Bare-callsign detection (`kind-floor` without the project prefix) — collision-prone with ordinary hyphenated words; decided against in [P04].
- Any change to reporter wake policy, sitrep cadence, or which events produce posts.

#### Dependencies / Prerequisites {#dependencies}

- The content annotator and its scope machinery: `tugdeck/src/lib/annotator/*`, `tugdeck/src/components/tugways/annotation-scope.tsx`.
- `TugMarkdownBlock` (`tugdeck/src/components/tugways/tug-markdown-block.tsx`) and the markdown lib (`tugdeck/src/lib/markdown/*`).
- `session-citation-store` (`tugdeck/src/lib/session-citation-store.ts`) and its `resolve_sessions` CONTROL verb — already resolves short ids server-side and caches misses.
- `TugSessionCitation` (`tugdeck/src/components/tugways/tug-session-identity.tsx`).
- The gazette ledger surface in tugcast: `session_ledger.rs::list_gazette_posts_tail`, `agent_supervisor.rs::do_list_gazette_posts`.
- Rebuilding the app bundle for app-tests after any Rust change (`just build-app` first — app-test refreshes dist, never the binary).

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** across the Rust workspace (`-D warnings`).
- Tuglaws for all tugdeck work: [L02] external state via `useSyncExternalStore` only; [L03] `useLayoutEffect` for registrations events depend on; [L06] appearance via CSS/DOM, never React state; [L20] consumer-scoped token tuning; [L26] keyed identity for rows that resolve in place; [L27] every acquisition hands back a release — this plan makes three (the citation-store source inside the `VerdictBatcher`, the portal hook's post-annotate registration, the store's page-request correlation timer if one is used). Cross-check `tuglaws/tuglaws.md` before implementing; name the laws in commits.
- Never hand-roll UI that exists as a Tug\* component; the citation chip is `TugSessionCitation`, the atoms are `TugAtomChip`.
- App-tests run selectively (`just app-test-changed`); new tests must carry `@covers` headers; the output is the report — never pipe it.
- Shared `changes.db` is untouched; the gazette ledger lives in tugcast's own DB and its reads here are additive queries, no schema change (no `CHANGES_SCHEMA_VERSION` bump needed).

#### Assumptions {#assumptions}

- CommonMark hard-break semantics are acceptable for post bodies: a single newline inside a paragraph renders as a soft break (space), a blank line starts a new paragraph — exactly the Session transcript's semantics. Reporter/Operator posts observed in the wild already use blank-line paragraphing. See [P02].
- `GAZETTE_TAIL_LEN` (referenced at `agent_supervisor.rs` from `crate::feeds::reporter`) is the current fixed tail length; the paged protocol subsumes it.
- The Reporter's backtick habit is real but unasked-for: nothing in `REPORTER_POST_INSTRUCTIONS` requests code spans today, and the errata's evidence that literal backticks reach the reader is evidence the model emits them anyway. [P11] makes it an instruction rather than an accident, so Step 1's visible payoff does not depend on a habit.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses the devise-skeleton v4 conventions verbatim: explicit `{#anchor}` on every cited heading, kebab-case anchors without phase numbers, stable two-digit labels (`[P01]` plan-local decisions, `[Q01]` open questions, `Spec S01`, `Risk R01`), `**Depends on:**` lines citing `#step-N` anchors, and `**References:**` lines citing labels and anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does `resolve_sessions` accept `project/callsign` as the queried id? (RESOLVED — no) {#q01-resolve-callsign}

**Question:** The session-citation store expands short ids server-side; whether the full `project/callsign` string, or only the callsign, is a valid query key.

**Why it matters:** [P04] detects `project/callsign` pairs; if the resolver only takes the callsign half, the detection candidate must be split before resolving and the project half checked against the answer's `projectDir`.

**Resolution:** RESOLVED by reading `session_ledger.rs::resolve_session_ids` and its doc comment. Three query shapes are accepted and no others: a **full session uuid** (exact match), an **8-char short id** (prefix match, and a non-unique prefix resolves to *nothing* rather than to a guess), and a **bare callsign** (exact match on the `tag` column, same uniqueness demand). `project/callsign` is not a key — a pair sent whole falls through every arm and comes back `unknown`. `tug-atom-markdown-body.tsx` passing `sessionAtomCallsign(atom.value)` is therefore not merely a precedent, it is the only shape that works.

**What this fixes in the plan:** [P04]'s pair detection resolves through the **callsign half** (split with the existing `sessionAtomCallsign` / `sessionAtomProject` helpers from `lib/session-atom-shape.ts`), and the **project half is verified against the answer's `projectDir`** — a `found` whose `projectDir` basename does not match the detected project half is treated as `refuted`. That project check is what earns the pair shape its keep over the bare callsign [P04] rejected: without it the pair adds nothing but characters.

**Carried forward:** the ledger's `tag` column holds the *composed* callsign for a fork lineage (`root_tag` / `tag_lineage` are separate columns). Step 6's first task is to read what `tag` actually spells for a forked session and widen the [P04] grammar to match it, or forked sessions are undetectable by construction and the plan should say so.

#### [Q02] Can the scrollback app-test seed ledger history? (RESOLVED — no, and it never could) {#q02-scrollback-apptest}

**Question:** whether an app-test can seed 60+ ledger rows to exercise paging.

**Resolution:** RESOLVED — no. The premise this question rested on is false: `publishGazettePost` (`test-surface.ts`) routes to `_ingestGazetteFrameForTest`, which JSON-parses the payload and hands the bytes straight to the **client store's** `_onGazette`. It never touches the wire and never reaches tugcast, so nothing it publishes is persisted and no amount of it seeds a ledger.

**What this fixes in the plan:** Step 10's coverage splits in two, and neither half is a mock.

1. **The paging itself** — `session_ledger.rs` tests over a real ledger (page boundaries, `has_more`, ordering) plus `gazette-store.test.ts` over the real fold/prepend/dedupe.
2. **The rendered prepend and the scroll anchor** — a new test-surface verb, `publishGazettePostsPage(payloadJson)`, that hands a `list_gazette_posts_ok` body to the production `publishListGazettePostsOk` bus. That drives the real `onTail` page branch, the real dedupe, the real layout-effect compensation, and the real DOM — the same production chain a wire response takes, entered one function later. It is the `publishGazettePost` pattern applied to the CONTROL response instead of the feed frame, and it belongs beside it in `test-surface.ts` (bump the surface version note).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Markdown collapses single-newline breaks the Reporter relied on | low | med | [P02]: accept CommonMark semantics (transcript parity is the point); instructions already produce blank-line paragraphs | posts visibly run together after Step 1 |
| Session scan fights the path scan over `project/callsign` tokens | med | **high** | Risk R01 below — the naive reading of "scan order" does NOT mitigate this | `tugdeck/src` renders as a slashed chip, or a callsign stays dead |
| Scroll-anchor math jumps the viewport on prepend | med | low | [L06] `useLayoutEffect` scrollTop compensation off a `prevScrollHeight` ref written by the previous layout pass (#scrollback-mechanics); assert in test | visible jump when older posts load |
| Copy resolver returns null on Gazette DOM shapes | low | low | resolver falls back to plain text by design ([P07] in transcript helpers); dev-log warns | warn spam in `tugDevLog` |
| Unbounded row accumulation after the render cap is removed | med | med | [P10]'s `GAZETTE_MAX_ROWS` ceiling | scroll jank or memory growth after several pages |

**Risk R01: Session detection vs path detection contention** {#r01-session-vs-path}

- **Risk:** `tugtool/kind-floor` is shaped exactly like a relative path; whichever scan claims the text run first blocks the other, and a wrong claim either paints a session chip over a real directory name or leaves a real session spelling dead.

- **What does NOT mitigate it (the correction).** An earlier draft of this plan claimed scan order settles the contest and that a refuted session mark hands the run back to the path scan. Neither is true of the code as it stands, and both had to be designed rather than assumed:

  1. **Order is not precedence.** `annotatePathsInText` pushes every scan's matches into one array, sorts by `start`, and `wrapMatchesInTextNode` drops any match overlapping a run already taken. Running the session scan first wins only ties at an *identical* start offset, and only by sort stability — an accident, not a mechanism.
  2. **The first pass produces no session match at all.** `sessionCitationStore.getAnswer()` answers `pending` for anything never asked, so on the pass that renders a post the candidate has no verdict. Following the path precedent (`payloadForReference` yields `null` for every state but `confirmed`), a pending candidate would contribute nothing — and the path scan claims the token in that same pass whenever the directory really exists.
  3. **Nothing would ever undo it.** `dropStaleWraps` re-checks only `file-path` and `directory` wraps and keeps a still-confirmed path, so the later `confirmed` session verdict could never upgrade the run. Symmetrically, `dropStaleWraps` has no session arm, so a refuted session mark would never be cleared either.

- **Mitigation (the real one), two mechanisms, both specified in [P05]:**
  - **A reserved run.** A session candidate whose verdict is `pending` contributes a *reservation* to the match list — a zero-payload entry the wrapper does not wrap but which the overlap check still honors, so the path scan cannot claim the run while the answer is in flight. The container is stamped `data-tugx-awaiting` by the existing `trackAwaits` counter (the session resolver joins `resolvePath`/`resolveCommit` there), so the verdict batch re-runs the pass and the run is decided exactly once, with an answer in hand.
  - **A session arm in `dropStaleWraps`.** A `session` wrap whose target no longer resolves `confirmed` is unwrapped, and `unwrapMatch`'s `normalize()` folds the text back so the *next* pass sees one run again and the path scan may claim it.
- **Verify both directions in the Step 6 unit tests:** a real repo dir with no matching session stays a path annotation; a real session spelling that is not a directory becomes a citation; and a run whose session verdict is still pending is claimed by *neither* scan on that pass.
- **Residual risk:** a token that is *both* a live directory and a live session callsign resolves as a session — now actually true, because the reservation holds the run until the session verdict arrives. Acceptable: the shape constraint (`word-word` slug, no dots, no further slashes) plus the [Q01] project-half check makes real collisions rare, and the session reading is the Gazette's dominant intent.

---

### Design Decisions {#design-decisions}

#### [P01] Post bodies render through `TugMarkdownBlock`, static mode, remount-keyed (DECIDED) {#p01-markdown-block}

**Decision:** `GazettePostBody` replaces its `<p>` with `TugMarkdownBlock initialText={post.body}` keyed by `post.key`, inside a wrapper `div.gazette-post-body` that keeps the reading measure and carries the cell-menu `bodyRef`.

**Rationale:**
- One move buys the whole transcript feature set: pulldown-cmark parse, DOMPurify sanitize, `renderIncremental`'s enhancer chain (`enhanceFencedCode` → `enhanceImg` → `annotateContent` → `enhanceTable` → `enhanceMath` → `enhanceMermaid`) — inline-code annotation, syntax-highlighted fences, bare-URL anchors, tables, math.
- The block picks its `AnnotationContext` up from the `AnnotationScope` the Gazette row already mounts (`useGazetteAnnotation`) — no prop threading.
- Static mode is correct: a post body never changes after it is written; the pending→answer swap is already a React key change (`[L26]`), which remounts the block.

**Implications:**
- `useAnnotatedElement` leaves `GazettePostBody` (the markdown path annotates itself); the import may leave `gazette-card.tsx` entirely if nothing else uses it.
- `.gazette-post-body`'s `white-space: pre-wrap` is deleted (markdown blocks own their whitespace); `max-inline-size: 64ch`, `font-size: 13px` stay on the wrapper so `gazette-measure.ts`'s derived widths remain true.
- `findable` stays `false` (see #non-goals).
- Markdown token tuning (`--tugx-md-*`) happens under `.gazette-post-body` per [L20], mirroring `.session-card-transcript-code-body`'s overrides in `session-card.css` where the Gazette needs the same values.

#### [P02] CommonMark newline semantics, unmitigated (DECIDED) {#p02-commonmark-newlines}

**Decision:** Post bodies adopt the transcript's exact markdown semantics; no pre-wrap shim, no newline-to-`<br>` preprocessing.

**Rationale:** the ask is parity with the Session transcript, which renders CommonMark; a Gazette-only newline dialect would be a second markdown. Observed posts already paragraph with blank lines.

**Implications:**
- If a post authored with single hard newlines reads as run-on after this ships, the fix is instruction-side (the Reporter writes markdown), not renderer-side.
- **Block-leading punctuation now means something, and that is accepted, not a regression.** A post beginning `#`, `-`, `*`, or `1.` renders as a heading or a list item rather than as literal characters. Snake_case is safe without a shim — CommonMark forbids intraword `_` emphasis, so `session_id` and `at_ms` render verbatim — and `*` mid-sentence needs a matching partner to do anything. The exposure is narrow enough to take: this is what "the transcript's exact semantics" costs, and [P11]'s authoring rule makes the model's markdown deliberate rather than incidental.

#### [P03] Copy: markdown resolver on the cell, raw body on the Z1B button (DECIDED) {#p03-copy}

**Decision:** `useTranscriptCellMenu` in `GazettePostRow` gains `resolveCopyMarkdown: (bodyEl, sel) => selectionToTranscriptMarkdown(sel, bodyEl)`; the Z1B `BlockCopyButton` keeps `getText={() => post.body}`.

**Rationale:** selection copy must reconstruct markdown from rendered DOM ([P03]/[P05] in `transcript-host-helpers.ts` — two clipboard flavors, `text/html` re-rendered via `transcriptMarkdownToHtml`); the whole-post button already holds the markdown *source*, which is exactly the right `text/plain`.

**Implications:** the `bodyRef` handed to the hook must point at the markdown container so `selectionToTranscriptMarkdown`'s walk sees the rendered blocks.

#### [P04] Session detection shapes: full UUIDs and `project/callsign` pairs only (DECIDED) {#p04-session-shapes}

**Decision:** The new detector recognizes (a) full UUIDs (`8-4-4-4-12` lowercase hex) and (b) `project/callsign` pairs where the callsign half is a strict two-word lowercase slug (`[a-z]+-[a-z]+`, no digits, no dots, no further slashes), both on token boundaries. Bare callsigns are not scanned.

**Rationale:** user-selected. UUIDs are collision-free; the pair shape is distinctive enough to scan; a bare `kind-floor` collides with every hyphenated compound in ordinary prose and would cost a resolver round-trip per false positive.

**How a pair is actually resolved ([Q01]).** The ledger has no `project/callsign` query key — `resolve_session_ids` takes a full uuid, a unique 8-char prefix, or a **bare callsign matched exactly against `tag`**. So a detected pair is split with the existing `sessionAtomCallsign` / `sessionAtomProject` helpers, the **callsign half** is what goes to the citation store, and the **project half is checked against the answer's `projectDir`** (basename comparison) before the candidate counts as confirmed. A callsign that resolves under a different project is `refuted`, not `found`. That check is the whole reason the pair shape beats the bare callsign this decision rejected: the project half is evidence, not decoration.

**Implications:**
- An Operator post that names a session only by bare callsign stays plain — the prose-hygiene instructions (Step 8) tell the model to spell the pair.
- **Forks are an open grammar question, not a silent miss.** `tag` holds the *composed* callsign for a fork lineage (`root_tag` and `tag_lineage` are separate columns), so a forked session's spelling may not fit `[a-z]+-[a-z]+`. Step 6's first task reads what `tag` spells for a real forked session and either widens the grammar to match or records here, explicitly, that forked sessions are out of detection's reach.

#### [P05] Session candidates resolve through the citation store; only confirmed candidates keep their mark (DECIDED) {#p05-session-verdicts}

**Decision:** A candidate's verdict decides its fate on the pass that sees it, in three arms — and a `pending` candidate **reserves its run** rather than yielding it:

| Verdict | What the pass does |
|---|---|
| `pending` (unasked or in flight) | Contribute a **reservation** to the match list: an entry the wrapper honors for overlap purposes but does not wrap. No mark, no DOM change — and no other scan may claim the run. `trackAwaits` counts it, so the container is stamped `data-tugx-awaiting` and the verdict batch brings the pass back. |
| `confirmed` (`found`, project half agrees) | Wrap the run and stamp `data-tug-annotation="session"` with the payload; [P06] portals the live chip into it. |
| `refuted` (`unknown`, or a project-half mismatch) | No mark. An existing `session` wrap is unwrapped by `dropStaleWraps`'s new session arm, whose `normalize()` folds the text back so the next pass sees one run and the path scan may claim it. |

**Rationale:**
- `TugSessionCitation`'s own unresolvable rendering (the slashed inert chip, [P13]/[D132] in the store's doc) is correct for *declared* refs but wrong for *scanned* prose — a look-alike token that isn't a session must remain ordinary text, not wear a slashed chip. So resolution gates the mark, exactly as the path scan's verdicts gate path marks.
- The reservation exists because the path scan and the session scan want the same characters and only one of them can have them, while the answer that decides it is asynchronous. Deciding the run before the answer arrives — which is what any order-based scheme really does — decides it wrong roughly whenever the token is also a real directory. Holding the run for one verdict batch (≈100ms, `VerdictBatcher`'s window) costs a moment of plain text and buys a correct answer. See Risk R01 for why the alternatives don't work.

**Implications:**
- `AnnotationContext` grows an optional `resolveSession` input; the citation store joins the existing `VerdictBatcher` sources; surfaces that don't supply it (gallery, non-transcript hosts) never mark session candidates and never reserve runs.
- `trackAwaits` grows a `resolveSession` arm alongside `resolvePath` / `resolveCommit`. Missing it is the silent failure mode — the container never gets `data-tugx-awaiting`, the batch never re-marks it, and every session in the post stays reserved-but-unmarked forever.
- `dropStaleWraps`'s guard, which today returns early for any kind that is not `file-path`/`directory`, must admit `session` — re-reading the target from the wrap's own `textContent` the way the path arm re-derives its reference.
- The resolver adapter calls `sessionCitationStore.request()` on a cache miss, which is a side effect inside a synchronous pass. That matches `pathResolutionStore.lookup`'s existing contract exactly (record the want, answer `pending`, notify on arrival), so it introduces no new pattern — but the adapter must be the *only* caller, so the ask is deduped by the store rather than by luck.

#### [P06] Confirmed session spans render the real `TugSessionCitation` via portals (DECIDED) {#p06-citation-portals}

**Decision:** A hook (`useSessionCitationPortals(containerRef)`) collects confirmed session spans (`[data-tug-annotation="session"]`) **after each annotation pass**, empties each span, and portals `<TugSessionCitation citedId={target}/>` into it — the `injectAtomHosts` + portal technique from `tug-atom-markdown-body.tsx`.

**Rationale:** "exactly as the transcript" means the live citation chip, which is a React component with its own gesture, hover, and resolution states; the annotator is a DOM pass and cannot mount it — portals bridge the two, and the technique is proven on atom chips.

**The seam is explicit, because there isn't one today.** `TugMarkdownBlock` owns its `annotateElement` calls inside its own layout effects; a sibling hook subscribing to the same `VerdictBatcher` has **no ordering guarantee** against them. It would appear to work — child effects subscribe before parent effects, so the block's listener happens to run first — and that is an accident of tree shape, not a contract; one refactor that moves the hook up a level silently starts collecting spans before they exist. So the block gains an `onAnnotated?: (container: HTMLElement) => void` prop, invoked after every pass it performs (mount render, context change, and each gated verdict re-mark). The hook registers through that, not through a second subscription. A `MutationObserver` on the container is the fallback if the prop proves awkward for the transcript's assistant cell, but the prop is preferred: it fires exactly once per pass, where the observer fires per mutation batch and has to be debounced back into the same thing.

**Implications:**
- The chip owns its whole gesture (as `RefAtom`'s session branch already notes), so the Gazette's delegated click layer and the annotation registry need no session `primaryClick`; the registry entry exists only so `annotationFromEvent` and menu sampling don't treat the host as a miss.
- **Portal hosts must be torn down when their host leaves the DOM.** Once [P05] gives `dropStaleWraps` a session arm, an unwrap detaches a node React may still be portaling into. Every collection pass therefore rebuilds the host list from the live DOM and drops entries whose element is no longer `container.contains(...)`-reachable — the list is a function of the current DOM, never an accumulation. [L27]: the `onAnnotated` registration hands back its release.
- `[L03]` for the layout-effect walk; the collected host list is React state holding *identity*, not appearance, which is why it is state at all ([L06] is unbothered — nothing about how the chip looks lives here).

#### [P07] Operator answers stamp `session_id` from a sole session ref the ledger holds (DECIDED) {#p07-operator-session-stamp}

**Decision:** In `operator.rs`'s answer publish, `session_id` is set to the target of the sole `session` ref **only when the ledger holds that session**. Zero session refs, two or more, or one the ledger cannot answer for all leave it `None`.

**Rationale — and the correction to "validate_refs already vets them".** It does not, for this kind. `validate_refs` exempts `Session` refs from the verbatim-corpus check outright (`reporter_wake.rs`: `matches!(r.kind, GazetteRefKind::Session) || …`). That exemption is sound where it was written — the *Reporter's* session id is stamped by the bridge from the wake, so it is ground truth that legitimately appears in no frame's text — but the **Operator's** session refs are model-recalled from verb results and pass through entirely unvetted. Stamping `session_id` straight off one of them promotes an unchecked string to the row's identity, where it becomes a header citation, a `chipRefs` filter key, and a raise target.

So the stamp gets its own gate, and `OperatorContext` already holds what it needs: `ctx.ledger.get(target)` answers whether the session exists. A shape check alone (uuid-only) would be the minimum, and is worth keeping as the cheap first arm — it also rejects the `project/callsign` spelling the model might write into a ref target, which `TugSessionCitation` could not resolve anyway ([Q01]: the pair is not a query key) — but the ledger check is what makes the header honest.

**Implications:**
- The Gazette's existing `chipRefs` filter (drops the ref matching `post.sessionId`) automatically stops double-rendering it as a trailing chip; the header-trailing `TugSessionCitation` appears via the existing `headerTrailing` wiring. Both hold by construction, since the stamped id *is* the ref's target.
- An unverifiable session ref is still **kept as a ref** — it renders in the provenance strip as `RefAtom`'s session branch already renders it, inert if unresolvable. This decision governs only what is promoted to `session_id`.
- Display-side session annotation ([P04]–[P06]) is not a substitute for this gate: it decides whether *prose* gets a chip, and says nothing about the row's identity.

#### [P08] Truncation is fixed in the instructions; the clamp becomes a sentence-boundary backstop (DECIDED) {#p08-complete-sentences}

**Decision:** `REPORTER_POST_INSTRUCTIONS` gains an explicit complete-sentences rule — write sentences that *fit* the 200-character prose budget; nearing the budget means ending the sentence sooner, never letting the cut land mid-clause. `REPORTER_PROSE_LIMIT` stays 200. `clamp_post_body` (the backstop for a model that ignores the rule) cuts at the last sentence-ending punctuation within budget when one exists, else at the existing token boundary.

**Rationale:** user-directed — the missing piece was never budget size, it was that nothing told the model to compose complete sentences within it. The backstop follows the same principle so that when it does fire, the post still ends on a period.

**What counts as a sentence end.** `.`, `!`, or `?` followed by whitespace or end-of-body — the same rule stated three ways is the trap here, because a `.` is also the most common character inside the exact names `prose_len` deliberately exempts. Two cases must be pinned before this ships:

- `main.rs.` at a sentence end is a sentence end (the `.` is followed by whitespace; the `rs.` inside is not).
- `e.g.` and `i.e.` are **not** sentence ends, even though each `.` is followed by a space in `e. g.`-adjacent spellings and the trailing one is followed by a space always. Either carry a small abbreviation deny-list or require the punctuation to be preceded by a token of ≥2 characters that is not itself abbreviation-shaped — the deny-list is smaller and easier to read, and `prose_len`'s own `token_is_exempt` already carries the precedent of naming `e.g.`/`i.e.` explicitly.

**Implications:**
- The instruction-pinning test in `gazette_agent.rs` gains an assertion on the new wording.
- `clamp_post_body` tests gain sentence-boundary cases **and one existing test changes rather than merely growing**: `clamp_post_body_passes_short_bodies_and_cuts_long_ones` asserts the trailing `…`, which no longer holds for a body that ends on a sentence boundary inside budget. Split it — the ellipsis assertion stays on the no-sentence-end case, and the boundary case asserts the period and the *absence* of the ellipsis.
- `prose_len`'s exemptions are untouched, so a path- or sha-heavy body still cuts where it cut before.

#### [P09] Operator prose hygiene: no epoch-ms, no bare UUIDs (DECIDED) {#p09-operator-hygiene}

**Decision:** `OPERATOR_ANSWER_INSTRUCTIONS` gains rules: express times as human dates/clocks, never raw epoch milliseconds; name sessions by their `project/callsign` or title, never a bare UUID in prose — the UUID belongs in the refs.

**Rationale:** observed answers say "at 1786572090962" and spell full UUIDs mid-sentence; both are results-serialization artifacts leaking into prose. Display-side session annotation ([P04]–[P06]) is the backstop, not the fix.

**Implications:** pinned-string test updated alongside.

#### [P10] Scrollback follows the `GitLogStore` shape: keyset pages, `has_more`, accumulated walk (DECIDED) {#p10-scrollback-shape}

**Decision:** `list_gazette_posts` gains optional `before_id` and `limit`; the response gains `has_more` and echoes `before_id`; the ledger gets a keyset query (rows with `id < before_id`, newest-first, `limit+1` fetched to compute `has_more`); the store accumulates pages and exposes `loadOlder()` with a `loadingOlder` flag; the card triggers `loadOlder` near scroll-top and compensates `scrollTop` on prepend.

**Rationale:** `git-log-store.ts` is the repo's proven load-more model (page size, `has_more`, `loadingMore`, accumulated walk, request correlation); keyset-by-rowid beats offset because live posts keep appending while the reader pages.

**The accumulated list keeps a ceiling.** `commit()`'s `slice(-cardRows)` is the only bound on the row list today, and removing it outright would make the Gazette an unbounded column of live `TugMarkdownBlock`s — each with its own annotation subscriptions and portal hosts, over a per-row `VerdictBatcher`, under a `useGazetteRefRoots` memo that walks every post on every change. That is the shape the transcript has a whole DOM-eviction project for; the Gazette must not acquire the problem while importing none of the remedy. So:

- `card_rows` is repurposed as the **initial tail request size** (sent as `limit`) and stops being a render-time truncation. Its user-facing meaning changes from "how many rows the card shows" to "how much history the card opens with" — worth a line in the tugbank default's own doc comment, since the knob's name outlives the change.
- A new module constant `GAZETTE_MAX_ROWS` (start at 10× the default tail — 500) caps the accumulated list. `commit()` still slices, but from the **young end** when paging (`slice(0, GAZETTE_MAX_ROWS)` keeps what the reader is reading) and from the old end otherwise, so following the bottom behaves exactly as it does today.
- Reaching the ceiling sets `hasMore` false-ish for the purposes of `loadOlder` — the store stops asking for pages it would only throw away — and the card says nothing about it. A reader 500 posts deep in a narration channel wants search, which is errata item 10's follow-on, not another page.

**Implications:** the tail response (`before_id` absent) replaces; a page response (`before_id` present) prepends with the existing id/key dedupe; both then pass through the ceiling. `gazette-store.test.ts` pins the ceiling's direction — that paging drops the *newest* rows and following drops the oldest.

#### [P11] The Reporter is told to write the markdown the surface now renders (DECIDED) {#p11-authoring}

**Decision:** `REPORTER_POST_INSTRUCTIONS` gains one sentence in its length paragraph, alongside [P08]'s complete-sentences rule: wrap exact names — paths, shas, symbols, commands — in backticks. Nothing more. No lists, no headings, no emphasis guidance.

**Rationale:** Step 1's headline win is that a backticked name renders as a styled, annotated code span instead of literal backticks — and nothing in the instructions asks for backticks today. The errata's evidence is that the model emits them anyway, which makes the payoff a habit rather than a contract. Since Steps 5 and 8 are already editing these strings and re-pinning them, the marginal cost is one sentence and one assertion, and it converts an accident into the thing the renderer was built for. Deferring it to the follow-on list (where an earlier draft had it) meant shipping the renderer and waiting to find out how often the model cooperated.

**Why only backticks.** A code span is the one markdown construct whose value here is structural rather than decorative: `classifyInlineCode` runs the path resolver over every inline `<code>`, so a backticked path becomes clickable by being backticked. Lists and headings would only change how a 200-character notice looks in a narrow rail, and [P02] already accepts their block-leading punctuation as a cost rather than a feature — inviting more of it would be inviting the cost.

**Implications:** the `gazette_agent.rs` job-table pinning test asserts the backtick sentence with [P08]'s; the follow-on item about markdown *authoring* narrows to "structure beyond code spans, if the digest ever wants it" and stays deferred.

---

### Deep Dives {#deep-dives}

#### The annotator's session kind, end to end {#session-kind-flow}

New detection module `tugdeck/src/lib/annotator/detect-session-ref.ts`, modeled on `detect-commit-sha.ts` (token walk, punctuation-trimmed candidates, boundary checks). It emits `{start, end, target}` for the two [P04] shapes. Wiring points, all existing seams:

1. **Scan placement and the reservation** — `annotate-content.ts`'s text pass currently runs `scanPathReferences` then `scanCommitShas` into one match array, sorts by `start`, and lets `wrapMatchesInTextNode` drop overlaps. The session scan is inserted *before* the path scan, but **placement is not what settles contention** — the `pending` **reservation** from [P05] is (see Risk R01 for why order alone cannot be). Concretely, `TextRunMatch` gains an optional `reserved?: true` and `wrapMatchesInTextNode` honors a reserved entry in its `cursor` arithmetic without emitting a span for it: the run is consumed, nothing is wrapped, the surrounding text is left whole. UUIDs need none of this — hyphens exclude them from both the path and the sha grammars, so they overlap nothing.
2. **Payload** — `payloads.ts` gains `{kind: "session"; target: string}`. This is the one change with the widest blast radius, because the kind union feeds four exhaustive switches and one array, and **missing any of them fails quietly or fails late**:
   - `AnnotationKind` (`types.ts`) — the union itself.
   - `datasetForPayload` / `payloadFromDataset` — encode/decode arms. A new kind decoding as nothing renders as nothing, which is the file's own stated warning.
   - `annotationValue` — what Copy and Insert into Composer yield. The cell menu reads it through `sampledAnnotationValue`, so a session with no arm gives the reader a Copy that copies nothing. **Decision: the full resolved session id**, matching what a raise or a clipboard flavor needs; the `project/callsign` spelling is what the *prose* already says.
   - `annotationOpensSurface` — decision: **false**. The chip owns its own gesture ([P06]), so the press needs none of the card-opening focus discipline.
   - `ANNOTATION_DATASET_KEYS` — the wholesale-removal list `clearAnnotation` walks. A key missing here means a cleared session annotation leaves its `data-target` behind, and the next `payloadFromDataset` reads a live payload off a dead element.
   - `registry.ts` — an entry with **no** `primaryClick`, so `annotationFromEvent` and menu sampling see a hit rather than a miss while the chip keeps its gesture.
3. **Context** — `AnnotationContext` (`types.ts`) gains optional `resolveSession(target): SessionVerdict` (pending/confirmed/refuted, mirroring the path verdict vocabulary) — absent means "don't scan". The adapter (`session-resolution.ts`) wraps `session-citation-store`: it splits a pair with `sessionAtomCallsign`/`sessionAtomProject`, asks with the callsign half or the whole uuid, answers `pending` while unasked/in-flight (calling `request()` on a miss, the `pathResolutionStore.lookup` contract), `confirmed` on a `found` **whose `projectDir` agrees with the project half** ([Q01]), and `refuted` on `unknown` or on a project mismatch. `trackAwaits` gains the matching arm so a pending session stamps `data-tugx-awaiting`. The store joins the `VerdictBatcher` sources in both `useGazetteAnnotation` (gazette-card.tsx) and the transcript's `useAnnotationContext` (`transcript-host-helpers.ts`).
4. **Verdict application** — the three arms of [P05]'s table: `pending` reserves the run and marks nothing; `confirmed` wraps and stamps; `refuted` marks nothing and, via `dropStaleWraps`'s new `session` arm, unwraps any existing session wrap so `normalize()` returns the run to the prose for the next pass.
5. **Rendering** — [P06]'s portal hook, mounted by `GazettePostBody` and by the transcript's assistant cell in the adoption step, driven by `TugMarkdownBlock`'s new `onAnnotated` callback rather than by a second `VerdictBatcher` subscription. The full resolved id for the citation comes from the citation store's answer (it returns the FULL id even when a short spelling or a callsign was asked — its documented contract).

#### Where the strip goes, precisely {#strip-placement}

`TugTranscriptEntry` renders `body` then `controls`. Today `GazettePostRow` passes `controls={<><GazettePostZ1B/>{refs strip}</>}` — strip *after* Z1B. The fix reorders within `controls`: strip first, then Z1B (`controls` is already `flex-direction: column` per the consumer override in `gazette-card.css`). CSS: `.gazette-post-refs` loses its `margin-block-start` role as "gap below Z1B" and instead sits at the controls slot's top margin; Z1B keeps its 2px top nudge relative to the strip. Result: body → unnamed-refs atoms → Z1B, which is "at the end of the content, above Z1B" with the atoms still outside the selectable prose.

#### Scrollback protocol and anchor math {#scrollback-mechanics}

Wire (additive, `protocol.ts` + `agent_supervisor.rs`):

**Spec S01: paged `list_gazette_posts`** {#s01-paged-list}

- Request: `{action: "list_gazette_posts", before_id?: number, limit?: number}`. Absent `before_id` = the tail (today's behavior); `limit` defaults server-side to the current `GAZETTE_TAIL_LEN`.
- Response: `{action: "list_gazette_posts_ok", posts: GazettePostWire[], has_more: boolean, before_id?: number}` — `before_id` echoed verbatim so the store can tell tail from page; `posts` oldest-first within the page.
- Ledger: `list_gazette_posts_page(before_id: Option<i64>, limit: usize)` in `session_ledger.rs` — `WHERE id < before_id` (or no predicate for the tail), `ORDER BY id DESC LIMIT limit+1`, reversed to oldest-first, `has_more = rows.len() > limit`.

**The response is a broadcast, not a reply.** `do_list_gazette_posts` sends `list_gazette_posts_ok` on the CONTROL **broadcast** bus, and `publishListGazettePostsOk` fans it to every subscriber — there is no request/response correlation anywhere in this path today, because the tail read is idempotent and a duplicate simply replaced the list with itself. Paging is not idempotent: a page applied twice prepends twice. The echoed `before_id` distinguishes tail from page but does not identify *whose* page it is. So the store holds a single `pendingBefore: number | null`, set when `loadOlder()` sends and cleared on arrival, and **ignores any page response whose `before_id` does not equal it** — which is what makes a stale page crossing a reconnect-driven tail re-request a no-op rather than a double prepend. One field, one comparison; the alternative (a real request id on the wire) is a protocol change this plan does not need.

Store (`gazette-store.ts`): snapshot gains `hasMore: boolean`, `loadingOlder: boolean`; `loadOlder()` no-ops unless `status === "ready" && hasMore && !loadingOlder && posts.length < GAZETTE_MAX_ROWS`, sends `before_id =` the oldest post's non-null `id` and records it as `pendingBefore`; `onTail` branches on the echoed `before_id` — absent: today's replace-and-merge (and clears `pendingBefore`, since a fresh tail supersedes any page in flight); present and equal to `pendingBefore`: prepend `[...page, ...current]` behind the existing key/id dedupe; present and unequal: dropped. `commit()` trades its `slice(-cardRows)` for the [P10] ceiling.

Card (`gazette-card.tsx`): the existing `onScroll` handler additionally fires `loadOlder()` when `el.scrollTop < LOAD_OLDER_PX` (~200). Anchoring is one mechanism, not two — an earlier draft offered "a ref written in the scroll handler *or* read from the previous layout pass", and the first of those is wrong: the scroll handler does not run on a prepend, so its ref would hold whatever the last human scroll saw. The mechanism is:

- A `prevScrollHeightRef`, written at the **end of every layout pass** over the transcript and read at the **top of the next one**. It is always the height as of the previously committed render, which is exactly what the compensation needs and is true regardless of what provoked the change.
- On a pass where the first post's key changed and `followingRef.current === false`, `el.scrollTop += el.scrollHeight - prevScrollHeightRef.current` ([L06] — a scroll write, never state).
- The `followingRef` guard is what keeps this from fighting the existing follow-the-bottom effect, which is keyed on `posts` as well and would otherwise be racing the compensation for the same `scrollTop`. In practice `followingRef` is already false whenever the reader is up reading history, so the guard is a statement of that invariant rather than a new condition — but the two effects touch one property, and which one owns it under which condition belongs in the code, not in the reader's head.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Rendered markdown DOM per post | appearance/structure inside the primitive | `TugMarkdownBlock` static `initialText` render — DOM written in a layout effect, no React state for content | [L06], [L03] |
| Session-verdict arrival re-render | external store | citation-store subscription folded into `VerdictBatcher` → the existing `useSyncExternalStore` sum in `useGazetteRefRoots` / block re-mark | [L02] |
| Citation portal hosts | local-data derived from DOM | React state set in the `onAnnotated` layout-effect walk (the `tug-atom-markdown-body` pattern); holds identity, never appearance | [L03] |
| `onAnnotated` registration + citation-store source | acquisition | registered in a layout effect, released by its cleanup | [L27] |
| `hasMore` / `loadingOlder` / `pendingBefore` / accumulated posts | external store | `GazetteStore` snapshot via `useGazette` | [L02] |
| Scroll-anchor compensation on prepend | appearance | direct `scrollTop` write in `useLayoutEffect` off `prevScrollHeightRef` | [L06] |
| Strip/Z1B ordering | structure | JSX order + consumer CSS in `gazette-card.css` | [L20] |

[L22] governs the *streaming* binding (`TugMarkdownBlock`'s own docstring says so); the Gazette mounts static `initialText` mode and never subscribes a `PropertyStore`, so it is [L06] + [L03] that apply here. Naming [L22] on these commits would claim a binding this plan does not create.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/annotator/detect-session-ref.ts` | UUID + `project/callsign` candidate scan ([P04]) |
| `tugdeck/src/lib/annotator/session-resolution.ts` | citation-store verdict adapter ([P05]) |
| `tugdeck/src/lib/annotator/__tests__/detect-session-ref.test.ts` | detection grammar unit tests |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `GazettePostBody` | fn | `tugdeck/src/components/gazette/gazette-card.tsx` | `<p>` → wrapper div + `TugMarkdownBlock` ([P01]); mounts citation portals ([P06]) |
| `GazettePostRow` | fn | same | `resolveCopyMarkdown` ([P03]); controls order strip-then-Z1B (#strip-placement) |
| `useGazetteAnnotation` | fn | same | gains `resolveSession` + its subscription ([P05]) |
| `useSessionCitationPortals` | hook | `tugdeck/src/components/tugways/annotation-scope.tsx` or a sibling module | portal collection/mount, host teardown ([P06]) |
| `onAnnotated` | prop | `tugdeck/src/components/tugways/tug-markdown-block.tsx` | post-pass seam; fires after mount render, context change, and each verdict re-mark ([P06]) |
| `SessionAnnotationPayload` | type | `tugdeck/src/lib/annotator/payloads.ts` | `{kind: "session"; target}` |
| `AnnotationKind` | type | `tugdeck/src/lib/annotator/types.ts` | `"session"` added to the union |
| `datasetForPayload` / `payloadFromDataset` | fn | `tugdeck/src/lib/annotator/payloads.ts` | exhaustive switches — new arms required to compile |
| `annotationValue` | fn | same | session arm → the **full resolved id** (#session-kind-flow) |
| `annotationOpensSurface` | fn | same | session → `false`; the chip owns its gesture |
| `ANNOTATION_DATASET_KEYS` | const | same | `target` added, or `clearAnnotation` strands the dataset |
| annotation registry entry | entry | `tugdeck/src/lib/annotator/registry.ts` | `session` kind, **no** `primaryClick` |
| `scanSessionRefs` | fn | `tugdeck/src/lib/annotator/detect-session-ref.ts` | ordered before `scanPathReferences` in `annotate-content.ts`; placement is not precedence (Risk R01) |
| `TextRunMatch.reserved` | field | `tugdeck/src/lib/annotator/wrap-matches.ts` | the pending reservation; consumed by `cursor`, never wrapped ([P05]) |
| `trackAwaits` | fn | `tugdeck/src/lib/annotator/annotate-content.ts` | `resolveSession` arm — without it nothing ever re-marks |
| `dropStaleWraps` | fn | same | `session` arm — without it nothing ever clears |
| `resolveSession` | field | `tugdeck/src/lib/annotator/types.ts` (`AnnotationContext`) | optional; absent = no scan, no reservations |
| `useAnnotationContext` | fn | `tugdeck/src/components/tugways/cards/transcript-host-helpers.ts` | transcript adoption of `resolveSession` |
| `encodeListGazettePosts` | fn | `tugdeck/src/protocol.ts` | gains `{beforeId?, limit?}` (Spec S01) |
| `ListGazettePostsOk` | interface | same | `has_more`, echoed `before_id` |
| `GazetteStore.loadOlder` | method | `tugdeck/src/lib/gazette-store.ts` | [P10]; plus `pendingBefore` correlation and the `GAZETTE_MAX_ROWS` ceiling |
| `GAZETTE_MAX_ROWS` | const | same | the accumulation ceiling ([P10]) |
| `publishGazettePostsPage` | fn | `tugdeck/src/test-surface.ts` | drives a real `list_gazette_posts_ok` page through the production bus ([Q02]) |
| `do_list_gazette_posts` | fn | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | parse `before_id`/`limit`, echo, `has_more` |
| `list_gazette_posts_page` | fn | `tugrust/crates/tugcast/src/session_ledger.rs` | keyset query (Spec S01) |
| operator answer publish | expr | `tugrust/crates/tugcast/src/feeds/operator.rs` | sole-session-ref stamp, **gated on `ctx.ledger.get`** ([P07]) |
| `clamp_post_body` | fn | `tugrust/crates/tugcast/src/feeds/reporter_wake.rs` | sentence-boundary backstop, abbreviation-safe ([P08]) |
| `REPORTER_POST_INSTRUCTIONS` | const | `tugrust/crates/tugcast/src/feeds/gazette_agent.rs` | complete-sentences rule ([P08]) + backtick authoring rule ([P11]) |
| `OPERATOR_ANSWER_INSTRUCTIONS` | const | same | prose hygiene ([P09]) |

---

### Documentation Plan {#documentation-plan}

- [ ] `at0365-gazette-card.test.ts` docblock updated to describe markdown bodies, strip placement, and (if added there) session citations; `@covers` lines extended for every new module it exercises.
- [ ] `gazette-card.tsx` module docstring: the "post bodies are selectable prose" and "no markdown resolver" claims rewritten to the new truth.
- [ ] `gazette-body-segments.ts` docstring: note that mention-matching runs against the raw markdown source, which is unaffected by rendering.
- [ ] `gazette-store.ts` module docstring + the `card_rows` tugbank default's own comment: `card_rows` now sizes the **opening request**, not the render window; `GAZETTE_MAX_ROWS` is what bounds the list ([P10]).
- [ ] `test-surface.ts` version note extended for `publishGazettePostsPage` ([Q02]), beside the `2.1.0` entry that introduced `publishGazettePost`.
- [ ] `annotate-content.ts` module docstring: the reservation is a third thing a pass can do to a run (mark / clear / hold), and the docstring's "every refusal is silent" paragraph should say that a held run is also silent — and why holding is not refusing ([P05]).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (`bun test` in tugdeck; `cargo nextest` in tugrust) | detection grammar, run reservation, clamp boundaries, store paging/dedupe/correlation, ledger keyset query | Steps 4–10 |
| **Integration (app-test)** | the rendered truth: markdown DOM, annotation stamps, scan contention, strip order, citation chips, copy flavors, page prepend | Steps 1–3, 6–7, 10 |
| **Golden / Contract** | pinned instruction strings in `gazette_agent.rs`'s job-table test | Steps 5, 8 |

#### What stays out of tests {#test-non-goals}

- No jsdom/fake-DOM render tests — banned pattern; rendered assertions live in app-tests driving the real app.
- No mocked-model tests of Reporter/Operator prose quality — instruction wording is pinned by string assertion; prose behavior is observed live.
- No full app-test sweep — selection stays `just app-test-changed` from `@covers`.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Rust changes require `just build-app` before any app-test run (app-test never rebuilds the binary). Frontend steps finish with `cd tugdeck && bunx vite build` — the debug app loads the prod rollup bundle.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Markdown post bodies | done | `0a5b25d1b` |
| #step-2 | Markdown-fidelity copy | done | `dc59435d5` |
| #step-3 | Provenance strip above Z1B | done | `ad77f2926` |
| #step-4 | Operator session_id stamp | done | `dd18b976d` |
| #step-5 | Reporter complete sentences + backticks + clamp backstop | done | `7661437bb` |
| #step-6 | Session annotation kind (detect/resolve/payload) | done | `6972654a7` |
| #step-7 | Citation portals + Gazette and transcript adoption | done | `33bc53c26` |
| #step-8 | Operator prose hygiene instructions | done | `0d15224a3` |
| #step-9 | Scrollback: protocol + ledger | done | `67d1eb133` |
| #step-10 | Scrollback: store + card gesture | done | `2cae1a4c5` |
| #step-11 | Integration checkpoint | done | `2382db8bd` |

#### Step 1: Markdown post bodies {#step-1}

**Commit:** `gazette(markdown-bodies): render posts through TugMarkdownBlock [L02][L20][L26]`

**References:** [P01] markdown block, [P02] CommonMark newlines, (#context, #strategy, #non-goals)

**Artifacts:**
- `GazettePostBody` rewritten: wrapper `div.gazette-post-body` (keeps `bodyRef` handoff and the measure) around `<TugMarkdownBlock initialText={post.body} key={post.key} findable={false}/>`; `useAnnotatedElement` removed from it.
- `gazette-card.css`: `white-space: pre-wrap` and `overflow-wrap: anywhere` dropped from `.gazette-post-body`; `--tugx-md-*` tuning added under it where Gazette sizes differ from primitive defaults (body font-size 13px / line-height 1.45 preserved); `max-inline-size: 64ch` retained (gazette-measure invariant).
- `gazette-card.tsx` module docstring updated (#documentation-plan).

**Tasks:**
- [ ] Replace the `<p>` body; verify the `AnnotationScope` context reaches the block (it reads `useAnnotationScope` itself — no prop needed).
- [ ] Confirm `unmentionedRefs` still filters against the raw `post.body` string (untouched by rendering).
- [ ] Check `gazette-measure.ts` constants still describe the rendered measure; adjust its comment if the box changes.

**Tests:**
- [ ] Extend `at0365-gazette-card.test.ts` claim 2: a seeded post with `` `real-file.ts` `` in backticks renders a `code` element with no literal backtick characters, and that element carries `data-tug-annotation`; a post with a bare URL renders an `<a>`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0365-gazette-card.test.ts`

---

#### Step 2: Markdown-fidelity copy {#step-2}

**Depends on:** #step-1

**Commit:** `gazette(copy-markdown): selection copy reconstructs markdown, two clipboard flavors`

**References:** [P03] copy, (#success-criteria)

**Artifacts:**
- `GazettePostRow`: `useTranscriptCellMenu({resolveCopyMarkdown: (bodyEl, sel) => selectionToTranscriptMarkdown(sel, bodyEl)})`; the hook's `bodyRef` pointed at the markdown wrapper.

**Tasks:**
- [ ] Wire the resolver; leave the Z1B `BlockCopyButton` on raw `post.body` ([P03]).

**Tests:**
- [ ] App-test: select across a bold+code run in a rendered post, invoke the row's Copy, assert the clipboard `text/plain` contains markdown syntax (`**`, `` ` ``) — follow `gallery-transcript-copy.tsx`'s driving pattern.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0365-gazette-card.test.ts`

---

#### Step 3: Provenance strip above Z1B {#step-3}

**Depends on:** #step-1

**Commit:** `gazette(ref-strip): unmentioned-ref atoms sit at content end, above the Z1B [L20]`

**References:** (#strip-placement), [P01], (#context)

**Artifacts:**
- `GazettePostRow` controls order: `{strip}` then `<GazettePostZ1B/>`.
- `gazette-card.css`: strip/Z1B margins swapped accordingly (strip takes the controls-slot top gap; Z1B spaces off the strip).

**Tasks:**
- [ ] Reorder JSX; retune the two margins; verify the wrap behavior of a many-chip strip against a narrow rail.

**Tests:**
- [ ] App-test: DOM-order assertion — within an entry's controls, `.gazette-post-refs` precedes `.gazette-post-z1b`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0365-gazette-card.test.ts`

---

#### Step 4: Operator session_id stamp {#step-4}

**Commit:** `tugcast(operator-session-stamp): sole session ref becomes the answer's session_id`

**References:** [P07] operator stamp, (#context)

**Artifacts:**
- `operator.rs` answer publish: after `validate_refs`, take the kept `session` refs; when there is exactly one, stamp `session_id` **only if** its target is uuid-shaped *and* `ctx.ledger.get(target)` answers `Some` ([P07]). Zero, many, or unverifiable → `None`.

**Tasks:**
- [ ] Implement the stamp behind both gates. `validate_refs` exempts `Session` refs from its corpus check entirely, so this is the only vetting an Operator session ref ever gets — the comment at the call site should say that, since the exemption reads as validation from a distance.
- [ ] Confirm the Gazette's `chipRefs` filter (drops the ref equal to `post.sessionId`) removes the now-duplicate trailing chip (it does — the filter exists in `GazettePostRow`, and the stamped id is the ref's own target by construction).

**Tests:**
- [ ] Rust unit test in `operator.rs`'s test module: one ledger-held session ref → stamped; one ref naming a session the ledger does not hold → `None`; one ref spelling `project/callsign` → `None`; two → `None`; zero → `None`.
- [ ] The unverifiable-ref case also asserts the ref itself is still **kept** — the gate governs `session_id`, not the provenance strip.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 5: Reporter complete sentences + backticks + clamp backstop {#step-5}

**Commit:** `tugcast(reporter-sentences): instruct complete sentences and backticked names; clamp cuts at sentence boundary`

**References:** [P08] complete sentences, [P11] authoring, (#success-criteria)

**Artifacts:**
- `REPORTER_POST_INSTRUCTIONS` (gazette_agent.rs): two additions to the length paragraph — sentences must be complete within the 200-character prose budget (nearing the budget means ending sooner, never trusting the cut), and exact names get backticks ([P11]).
- `clamp_post_body` (reporter_wake.rs): when the budget-truncated prefix contains sentence-ending punctuation (`.`, `!`, `?` followed by whitespace or end-of-body, and not part of an abbreviation), cut there and drop the ellipsis; otherwise the existing token-boundary + `…` behavior.

**Tasks:**
- [ ] Word both rules; update the job-table pinning test to assert both phrases.
- [ ] Implement the sentence-boundary branch with the abbreviation guard ([P08]); keep `prose_len` exemptions untouched.

**Tests:**
- [ ] `clamp_post_body` cases: over-budget body with an in-budget sentence end → cut ends on the punctuation, no ellipsis; over-budget with no sentence end → existing behavior; a body whose in-budget prefix ends `…main.rs.` → cuts there (it IS a sentence end); a body whose only in-budget `.`-runs are `e.g.` / `i.e.` → falls through to the token-boundary + `…` behavior; exempt-token counting unchanged.
- [ ] Split `clamp_post_body_passes_short_bodies_and_cuts_long_ones` — its `…` assertion no longer holds for every clamped body ([P08]).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 6: Session annotation kind — detect, resolve, payload {#step-6}

**Commit:** `annotator(session-kind): detect UUID and project/callsign spellings, resolve via citation store`

**References:** [P04] shapes, [P05] verdicts, Risk R01, [Q01] (resolved), (#session-kind-flow)

**Artifacts:**
- `detect-session-ref.ts` (+ unit tests), `session-resolution.ts` per #session-kind-flow — the adapter splits the pair, queries the callsign half, and checks the project half against `projectDir` ([Q01]).
- `payloads.ts` `session` kind **and every switch/list the union feeds** (#session-kind-flow item 2): `datasetForPayload`, `payloadFromDataset`, `annotationValue`, `annotationOpensSurface`, `ANNOTATION_DATASET_KEYS`.
- `types.ts` `resolveSession`; `wrap-matches.ts` `TextRunMatch.reserved`; `annotate-content.ts` scan wiring, `trackAwaits` arm, `dropStaleWraps` session arm; registry entry (no `primaryClick` — [P06]).
- `useGazetteAnnotation` supplies `resolveSession` and folds the citation store into its `VerdictBatcher`.

**Tasks:**
- [ ] Read what `tag` spells for a real **forked** session and either widen the [P04] grammar or record the limitation in [P04] ([Q01] carried-forward item). Do this first — it decides the grammar the rest of the step tests.
- [ ] Implement the reservation in `wrapMatchesInTextNode`: a `reserved` entry advances `cursor` and emits no span, leaving the surrounding text intact.
- [ ] Implement both verdict-plumbing arms — `trackAwaits` (or the container never re-marks) and `dropStaleWraps` (or a refuted mark never clears). Neither has a visible failure mode at the moment it is missed, which is why they are called out as tasks rather than left to the diff.

**Tests:**
- [ ] `bun test` — detection grammar: UUID hits; `tugtool/kind-floor` hits; `kind-floor` alone misses; `tugdeck/src` (no second hyphenated word) misses; boundary/punctuation trims.
- [ ] `bun test` — adapter verdict mapping: pending / found-with-matching-project / found-with-mismatched-project (→ refuted) / unknown (→ refuted).
- [ ] `bun test` — the reservation, over `wrapMatchesInTextNode` directly: a reserved run adjacent to a path match wraps the path and not the reservation; a reserved run overlapping a path match suppresses the path wrap; the node's text is byte-identical either way.
- [ ] `bun test` — contention, both directions (Risk R01): a real repo dir with no matching session ends as a path annotation; a real session spelling that is not a directory ends as a citation; a pending session verdict leaves the run unclaimed by either scan on that pass.

**Checkpoint:**
- [ ] `cd tugdeck && bun test detect-session && bun test wrap-matches && bunx tsc --noEmit`

---

#### Step 7: Citation portals + adoption in Gazette and transcript {#step-7}

**Depends on:** #step-1, #step-6

**Commit:** `gazette+transcript(session-citations): confirmed session spellings render the live citation chip [L02][L03]`

**References:** [P06] portals, [P05] verdicts, (#session-kind-flow, #state-zone-mapping)

**Artifacts:**
- `TugMarkdownBlock` gains `onAnnotated?: (container: HTMLElement) => void`, invoked after every pass it performs — the mount render, the context-identity re-mark, and each gated verdict re-mark ([P06]).
- `useSessionCitationPortals` hook; mounted by `GazettePostBody`, registered through `onAnnotated`.
- `useAnnotationContext` (transcript-host-helpers.ts) gains `resolveSession`; the assistant cell mounts the portal hook so transcript prose gets the same treatment.

**Tasks:**
- [ ] Add the `onAnnotated` seam first, and drive collection from it — **not** from a second `VerdictBatcher` subscription, which has no ordering guarantee against the block's own re-mark and only appears to work because child effects subscribe before parent ones ([P06]).
- [ ] Portal `TugSessionCitation citedId={resolved full id}`; rebuild the host list from the live DOM on every pass and drop entries whose element has left the container, so an unwrap by `dropStaleWraps` cannot leave React portaling into a detached node.
- [ ] Verify the delegated click layer ignores portal hosts (chip owns the gesture; `annotationFromEvent` on an anchor-less chip must not double-fire).

**Tests:**
- [ ] App-test (at0365 or a new `at04xx` with `@covers` for the new annotator modules): a post naming this checkout's real session spelling renders a citation chip in place; a look-alike that resolves `unknown` stays plain text; and a token that is a real repo directory stays a path annotation (Risk R01's rendered half — the unit tests cover the grammar, this covers the whole chain against a live ledger).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 8: Operator prose hygiene instructions {#step-8}

**Commit:** `tugcast(operator-hygiene): human dates and named sessions in answers, ids in refs`

**References:** [P09] hygiene, (#context)

**Artifacts:**
- `OPERATOR_ANSWER_INSTRUCTIONS`: rules per [P09]; job-table pinning test extended.

**Tasks:**
- [ ] Word the rules; keep the verbatim-refs contract paragraph intact.

**Tests:**
- [ ] Pinned-string assertions for both new rules.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 9: Scrollback — protocol + ledger {#step-9}

**Commit:** `tugcast(gazette-paging): keyset list_gazette_posts with before_id/limit/has_more`

**References:** [P10] scrollback shape, Spec S01, (#scrollback-mechanics)

**Artifacts:**
- `session_ledger.rs::list_gazette_posts_page`; `agent_supervisor.rs::do_list_gazette_posts` arg parsing + echo + `has_more`; `protocol.ts` request/response types per Spec S01.

**Tasks:**
- [ ] Implement per Spec S01; tail behavior with no args stays byte-identical for old clients.
- [ ] Echo `before_id` verbatim in the response. The CONTROL bus is a broadcast with no correlation of its own, so the echo is the store's only way to tell its page from anyone's tail (#scrollback-mechanics).

**Tests:**
- [ ] Ledger tests: page boundaries, `has_more` at exactly-limit, empty page, tail-vs-page ordering (oldest-first within each response), and a page taken while newer rows are being appended (the keyset's whole reason for being).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 10: Scrollback — store + card gesture {#step-10}

**Depends on:** #step-9

**Commit:** `gazette(scrollback): loadOlder on scroll-top with anchored prepend [L02][L06]`

**References:** [P10], Spec S01, [Q02], (#scrollback-mechanics, #state-zone-mapping)

**Artifacts:**
- `gazette-store.ts`: `hasMore`/`loadingOlder`/`pendingBefore` snapshot fields, `loadOlder()`, correlated prepend branch in `onTail`, `card_rows` re-purposed as the opening request `limit`, `GAZETTE_MAX_ROWS` ceiling replacing the render-time slice ([P10]).
- `gazette-card.tsx`: scroll-top trigger + `prevScrollHeightRef` compensation guarded on `followingRef` (#scrollback-mechanics).
- `test-surface.ts`: `publishGazettePostsPage`, feeding a real `list_gazette_posts_ok` body to `publishListGazettePostsOk` ([Q02]).

**Tasks:**
- [ ] Implement per #scrollback-mechanics, including the `pendingBefore` correlation — the response is a broadcast, and an uncorrelated page prepends twice.
- [ ] Write the compensation off the previous layout pass's recorded height, never off the scroll handler (which does not run on a prepend).

**Tests:**
- [ ] `gazette-store.test.ts`: page prepend dedupes against live-folded posts; `loadOlder` no-op guards (including at the ceiling); `hasMore` transitions; a page response whose `before_id` does not match `pendingBefore` is dropped; the ceiling drops the newest rows when paging and the oldest when following ([P10]).
- [ ] App-test via `publishGazettePostsPage`: an older page prepends above the reader's row and `scrollTop` compensation holds the reading line — the rendered half [Q02] showed no ledger seeding could reach.

**Checkpoint:**
- [ ] `cd tugdeck && bun test gazette-store && bunx tsc --noEmit && bunx vite build`
- [ ] `just build-app && just app-test-changed` (Rust changed in #step-9 — rebuild first)

---

#### Step 11: Integration checkpoint {#step-11}

**Depends on:** #step-2, #step-3, #step-4, #step-5, #step-7, #step-8, #step-10

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every success criterion against the running app; live-read a real Reporter post and a real Operator answer for rendering, citation, and strip placement.

**Tests:**
- [ ] `just app-test-changed` over the full working diff.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just build-app && just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Gazette posts render, annotate, cite, copy, and scroll like the Session card transcript, with tugcast shaping posts that read as complete, human sentences.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every success criterion in #success-criteria verified by its named test or command.
- [ ] `at0365-gazette-card.test.ts` (extended) green; any new app-test carries resolving `@covers` (`just app-test-covers-check`).
- [ ] No errata item 1–9 reproducible in the live app; item 10 (Find) recorded below as the deferred follow-on.

**Acceptance tests:**
- [ ] `just app-test-changed` green on the final diff.
- [ ] `cd tugrust && cargo nextest run` green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Find integration for Gazette posts: search-index projection + `findable` marking (errata item 10; see #non-goals).
- [ ] Reporter/Operator adoption of markdown *structure* beyond code spans — lists, emphasis — if the digest ever wants it. The backtick rule is not deferred; it ships with [P11] in #step-5, because it is what makes Step 1's code spans a contract rather than a habit.
- [ ] Fork-aware session detection, if [Q01]'s carried-forward task finds that composed lineage tags fall outside [P04]'s grammar and widening it in place would cost precision.

| Checkpoint | Verification |
|------------|--------------|
| Frontend clean | `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test` |
| Rust clean | `cd tugrust && cargo nextest run` |
| Rendered truth | `just build-app && just app-test-changed` |
