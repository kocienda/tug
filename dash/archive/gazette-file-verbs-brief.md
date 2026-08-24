# The Gazette needs eyes: file verbs for the Operator

The goal, stated by the work's owner: **the project's source code must be a content base the Gazette can work with comfortably** — and in particular, when the asker points the Operator at the exact file they want to ask about, the Operator must be able to answer from that file's actual content. Today it cannot, and the reason is structural, not a model quality problem: the Operator has no verb that reads a file, no way to prove a file was actually scanned, and no channel that carries the asker's pointing gesture past the composer. This brief describes those gaps against the evidence that exposed them and lays out the work that fills them, so a plan can be devised from it cold.

State of the world at writing: `main` carries the full gazette-intelligence-boost program (index vocabulary, ranking, the lexical relaxation ladder, Haiku expansion, `tugcast operator-ask`) and the gazette-fixes dash (prose-answer salvage, the `repo.grep` recovery ladder, the coined-term teaching, the user post's annotation root). Both landed 2026-08-16. The `[P06]` per-verb log line — `gazette operator verb round=… verb=… args=… outcome=… elapsed_ms=… size=…` — is live in every instance and is what made the diagnosis below a grep instead of an inference.

## Two incidents, one diagnosis

The same question was asked twice, a day of fixes apart: *"show me where we have the Z-zone drawing in the tuglaws/design-decisions.md document."* The asker @-completed the file atom in the composer, so the question named a real, existing file — the drawing is decision D97, at `tuglaws/design-decisions.md:267`, with the ASCII diagram starting at line 271. The Operator fumbled both times, differently.

### Incident A — 2026-08-16 06:31, release instance

Round 1 ran `repo.grep {"pattern": "Z-zone", "path_scope": "tuglaws/design-decisions.md"}` → 0 rows: the document never contains the literal "Z-zone" — its own vocabulary is "placement zones, `Z0`–`Z5`". The answer model then wrote honest prose ("No match for \"Z-zone\"…") without the JSON envelope, `parse_answer_turn` found no JSON span, and a readable answer was converted into the transient "Couldn't answer that: the answering step did not produce a readable answer." The week's logs showed this envelope discard was systematic — three occurrences in two days, two of them complete correct answers thrown away.

The gazette-fixes dash closed both halves: prose with no JSON in it is now salvaged as the answer body, and a zero-match `repo.grep` retries case-insensitively and then by the pattern's alphanumeric pieces, reporting `pattern_used` and a `note`. The `operator-ask` replay against a ledger copy then answered the question correctly — and notably the retrieve model, reading the new coined-term teaching, chose `pattern: "Z0"` on its own and hit exactly.

### Incident B — 2026-08-16 06:57, debug build carrying all of the above

The `[P06]` log for the round, verbatim:

```
gazette operator verb round=1 verb=repo.grep        args={"path_scope":"%design-decisions.md","pattern":"zone"}  outcome="ok" elapsed_ms=12 size=rows=0
gazette operator verb round=1 verb=changes.for_path args={"pattern":"%design-decisions.md"}                      outcome="ok" elapsed_ms=1  size=rows=4
```

Read it closely, because every part of the failure is in it. The grep **pattern** was perfect — `zone`, exactly what the teaching asks for. What killed the lookup is the **scope**: `%design-decisions.md` is SQL LIKE syntax, which is `changes.for_path`'s legitimate pattern grammar — the model called both verbs in the same round with the same string and let one verb's argument syntax contaminate the other's. As a git pathspec, `%design-decisions.md` matches no file. `git grep` therefore scanned *nothing*, and the new recovery ladder faithfully reran all three of its rungs against the same empty scope — the ladder relaxes the pattern, never the scope. The verb reported `ok, rows=0`.

Then the worst part: the answer model, holding `ok, rows=0` plus four `changes.for_path` rows, wrote a fluent, confident, **false** answer — "a grep for 'zone' in that file returned zero matches, so there's currently no section or diagram by that name in it," garnished with plausible speculation that the content may have been removed in a recent edit. A false absence claim delivered with citations is strictly worse than "couldn't answer": it teaches the reader to distrust every answer the channel produces.

### The diagnosis

Neither incident was a semantic-recall failure. Across both runs the model knew what to look for (`zone`, `Z0`), aimed at the right file, and structured its rounds sensibly. Every failure was **mechanical**: an envelope discarded, a scope silently matching nothing, and — underneath both incidents — the absence of any verb that could have simply opened the file the asker pointed at. Fix the mechanics and this class of question becomes routine; skip them and no amount of indexing will help, because an index feeds the same pipeline that just proved it can lose a perfect answer between the verb layer and the post.

## The gaps, named

### G1 — the Operator cannot read a file

The verb inventory (`VERB_NAMES`, `tugrust/crates/tugcast/src/feeds/operator.rs`) is thirteen verbs: seven ledger searches (`gazette.*`, `facts.*`, `shell.history`), two session verbs, two changes verbs, two git-history verbs (`git.log`, `git.show`), and `repo.grep`. **Nothing opens a file.** `repo.grep` returns matching lines truncated to 240 characters each — context-free needles, never the cloth. "Show me the drawing in this file" is unanswerable by construction even when grep hits, because a 30-line ASCII diagram cannot ride back as one-line matches; the same holds for "what does this file say about X", "summarize this document", "explain this function." The entire question class the owner cares about — the source code as a content base — dead-ends here.

### G2 — absence is not provable

A scoped `repo.grep` whose `path_scope` matches zero tracked files returns `ok, rows=0` — byte-identical to "the file exists and genuinely lacks the term." The model has no way to distinguish *I searched the file and it isn't there* from *I searched nothing*. Incident B is what that ambiguity produces: a confident absence claim about a file that was never scanned. Until an unmatched scope is an **error**, the instruction "never claim something is absent" is unenforceable — the model's evidence genuinely looked like a clean miss.

### G3 — the pointing gesture is discarded

The composer's `@` file completion produces a real atom, and the asker used it. On submit the atom flattens to its path text (`buildSlashCommandLine`, by design — the wire carries words), and `submitQuestion` sends only text plus image attachments. The pipeline receives a sentence, not a claim; it never learns that the question names a file, never verifies that the file exists (a microsecond stat against a root it now holds — the question post carries `project_dir` since gazette-fixes), and cannot seed the retrieve turn with anything about the file. The strongest signal a question can carry — *the asker attached the exact target* — evaporates at the first hop.

### G4 — cross-verb argument contamination is a standing hazard

Incident B's `%` is not a one-off quirk; it is the third observed member of a class. The model has previously written verb arguments flat on the verb object (recovered with `serde(flatten)` + `absorb_flat_args`), answered in prose where JSON was required (recovered with salvage), and now blended one verb's argument grammar into another's. The house pattern for this class is established and it works: **recover in Rust, teach in instructions, and never rely on the model to stop slipping.** Scope repair belongs to the same family as the flat-args fix, not to a hope that a sharper prompt ends the slips.

## Filling the gaps

### `repo.read` — the missing fundamental

A verb that returns a file's content as numbered lines. Arguments: `path` (required, repo-relative), and an optional range — either `start`/`end` line numbers or `around_line` + `context` (for "read around the grep hit"). Semantics worth pinning in the plan:

- **Tracked files only.** Resolve `path` against `git ls-files` before opening; a path that is not tracked is an error naming near-misses (see scope repair below). This keeps the verb inside the same trust boundary as `repo.grep` — the repository, not the filesystem — and composes with the existing escape guard (`path_arg`, pinned by `a_path_may_not_escape_the_project_dir`).
- **Hard caps, reported honestly.** A per-call ceiling on lines and bytes (on the order of ~200 lines / ~16 KB — the plan should pick the numbers against real answer-context budgets). A capped read says so: `truncated: true`, plus the file's total line count, so the model knows there is more and where it stands. An uncapped read of a 4,000-line file would spend the answer turn's entire context on one verb result; the cap plus `around_line` is what makes reading *targeted*.
- **Numbered lines.** The Operator's answers cite locations ("the drawing starts at line 271"); numbers in the result are what let it do that without arithmetic, and they compose with `repo.grep`'s `line` field: grep finds the line, read opens the neighborhood.
- **Working-tree content**, matching `repo.grep` (which greps the working tree — "what the tree says NOW" per its own instruction line). History belongs to `git.show`, which already exists.

The canonical flow this enables, and the plan's integration checkpoint should replay it end to end: *grep `zone` scoped to the file → hits at 267–331 → `repo.read` `around_line: 271` → the answer quotes the drawing and names its span.*

### `repo.outline` — structure at a glance

For "where in this document/file is X" questions, the direct answer is the file's own skeleton. `repo.outline` takes `path` and returns the file's structural lines with line numbers. First tier: **markdown headings** (`#` through `######`, fence-aware so a `#` inside a code block is not a heading) — that alone answers the incident question class, and `tuglaws/`, `dash/`, and every README become navigable. Second tier, deliberately deferred to keep the first cheap: code-file outlines (top-level `fn`/`struct`/`impl`/`export` shapes) — the plan can leave this as a follow-on with its own decision about how much parsing is worth doing without a real symbol index.

Outline is also the right **seeding payload** for G3: it is small (a few dozen lines for even a large document), it carries line numbers the model can act on immediately, and it converts "I should search" into "I can see the section named Z-zones right there."

### `repo.ls` — the model's own scope-repair tool (optional tier)

`git ls-files` filtered by a glob or basename fragment, small cap. It gives the model a way to answer "which file did you mean" itself and makes filename-only questions ("do we have a theme-engine doc?") one verb instead of a grep contortion. This is the lowest-priority verb of the three — the Rust-side scope repair below covers the common case without a round trip — but it is cheap, and its result shape (paths only) cannot bloat a context.

### Scope validation and repair — absence becomes provable

Applies uniformly to every verb that takes a path or scope: `repo.grep`'s `path_scope`, `repo.read`'s and `repo.outline`'s `path`. Before the underlying git call runs, resolve the argument against the tracked tree:

1. **Literal match** (exact tracked path, or a pathspec matching ≥1 tracked file) → proceed.
2. **No match → repair, cheapest first:** strip SQL LIKE artifacts (`%`, `_` at token boundaries — the observed contamination), then try the argument as a basename with a `*` glob (`*design-decisions.md`), then a case-insensitive basename match.
3. **Repair finds exactly one candidate** → use it, and report it: the result carries the corrected scope in a `path_scope_used`/`path_used` field plus a fixed `note` ("path_scope matched no file as written; searched <corrected> instead") — the same honesty contract as `pattern_used`/`query_used`, and the model reads it before citing.
4. **Repair finds several** → error listing the candidates, so the model's next round picks one by name.
5. **Repair finds none** → **error**, not `ok, rows=0`: "path_scope matched no tracked file; nearest names: …". The error rides `render_results` to the answer model like any verb error, which is exactly where it belongs — the model that would have claimed absence instead sees that the scan never happened.

After this lands, `ok, rows=0` from a scoped grep has one meaning: *the file was scanned and the pattern is not in it.* That single invariant is what makes the answer-side rule below enforceable, and it retires the G4 contamination class for scopes the same way `absorb_flat_args` retired it for nesting.

### Question refs ride the wire — the pointing gesture arrives

Three hops, smallest change at each:

1. **Composer** (`tugdeck/src/components/gazette/gazette-card.tsx`, `submit`): alongside the flattened text, collect the non-image atoms (type/file value = the path) and send them as structured refs on the question — `submitQuestion(text, attachments, refs)`, threading through the gazette store and the client→tugcast message (note the tugcode-style inbound allowlist hazard: the message type's schema changes in one place, but check the wire validation end to end).
2. **Pipeline** (`OperatorPipeline::handle`): the user post publishes with those refs (they render — the post already carries `project_dir` since gazette-fixes, and `unmentionedRefs` suppresses the duplicate chip when the prose names the path, so rendering stays clean). Each file ref is verified against the tracked tree at question time.
3. **Retrieve input** (`compose_retrieve_input` and its answer-side sibling): a verified mention becomes a preamble line the model cannot miss — *"The question names these files, verified to exist: tuglaws/design-decisions.md (2,431 lines)"* — and, for the strongest version of the fast path, the pipeline pre-runs `repo.outline` on each named file (bounded: first N files, outline caps apply) and includes the outline in the retrieve material. The Operator then starts the round already looking at the file's structure; for the incident question, round 1 becomes `repo.read around_line 271` and the answer is done.

A verification wrinkle the plan must handle: `validate_refs` currently vets answer-side refs against the verb-result corpus verbatim. Question-side refs are *user-supplied*, verified against the tree instead — they should not pass through the same corpus check (nothing has run yet), and the user post's refs need no session-promotion logic. Keep the two ref channels' rules distinct and pinned.

### Teachings, pinned

Additions to `OPERATOR_RETRIEVE_INSTRUCTIONS` and `OPERATOR_ANSWER_INSTRUCTIONS` (`tugrust/crates/tugcast/src/feeds/gazette_agent.rs`), each with a companion assertion in the job-table pin test:

- `path_scope` and `path` are literal repo-relative paths or git globs — **never** `%`-style LIKE patterns; `changes.for_path` is the only verb that speaks LIKE, and its `pattern` never travels to another verb. Name the contamination; the pin test asserts the sentence.
- A question **about a file's content** wants `repo.read`/`repo.outline`, not only grep: grep locates, read answers. "Show me", "what does it say", "explain" are read-shaped questions.
- **The absence rule, answer side:** never state that something is absent from a file unless a *scoped* scan of that file returned `ok` with zero rows — an errored or repaired scan is not evidence of absence. With G2 closed this is checkable by the model against its own results, and the instruction should say exactly what evidence licenses the claim.
- When `note`/`path_used`/`pattern_used` say a rung or a repair fired, say so in the answer rather than presenting a loose match as an exact one — extending the contract the search verbs already carry.

### Contracts the new verbs inherit

For the plan's checklist, the existing invariants every new verb must join: a `VERB_NAMES` entry whose executor and instruction listing are pinned by `the_verb_table_matches_the_instructions`; the `[P06]` per-verb log line (comes free via `log_verb` if dispatch goes through `run_verb`, which it must); `VERB_TIMEOUT` coverage; the `path_arg` escape guard; error text written for the model, not the log; and result fields that follow the `*_used` + `note` honesty convention. `MAX_VERBS_PER_ROUND` (6) and `MAX_RETRIEVAL_ROUNDS` (2) stay as they are — read-with-caps is designed to fit that budget, and the seeded outline reduces round pressure rather than adding to it.

## What this deliberately does not include: indexing and embeddings

The owner's instinct — "maybe the codebase needs to be indexed/embedded" — deserves a straight answer rather than deflection. The answer this brief takes: **not yet, and the evidence says why.** Every diagnosed failure across both incidents (and the two Aug 15 envelope discards) was mechanical — an answer lost after retrieval succeeded, or a scan that never ran. None was the failure an index fixes, which is *the model cannot name any word that appears in the relevant text*. The model named the right words every time. Building an index now would bolt a better retrieval layer onto a pipeline that demonstrably loses answers after retrieval, and its wins would be invisible behind the same mechanical losses.

The honest tier ladder, for when the mechanics are closed:

1. **File verbs + provable absence + carried mentions** (this brief) — closes the observed failure class entirely, including the exact incident question, at the cost of a few hundred lines of Rust and a small wire change.
2. **FTS over the tracked tree** — a `repo.search` verb backed by an FTS5 index of tracked text files, reusing the boost program's machinery wholesale: the `search_tokens` normalizer (sub-word decomposition already handles `TugTooltip → tug tooltip`), the sanitize/relax ladder, `query_used`/`note`. This is the cheap version of "the codebase is indexed," it answers lexical questions across the whole repo in one verb, and its freshness story (reindex on change, or index HEAD and say so) is a solvable design decision. Take it when — and only when — calibration shows questions failing for *cross-file lexical recall* reasons.
3. **Embeddings** — only if tier 2 measurably misses on paraphrase-level recall ("where do we stop two surfaces fighting over the keyboard"). Semantic indexing is a real capability with real costs (a model dependency in the index path, staleness, storage, and a much harder "why did this match" story); nothing observed so far justifies it.

The instrument for that decision already exists: `tugcast operator-ask`. The plan should grow the calibration habit the boost roadmap named — a small suite of standing questions (the Z-zone question among them) replayed against a ledger copy after each tier, with the `[P06]` lines as the scorecard. Whether tier 2 is needed becomes an empirical reading, not a hunch.

## Sequencing recommendation

- **Dash 1 — verbs and provable absence (G1, G2, G4):** `repo.read`, `repo.outline`, scope validation/repair across the path-taking verbs, the teachings, and the `operator-ask` replay of the incident question as the closing checkpoint. Self-contained in `operator.rs` + `gazette_agent.rs`; unit-testable end to end against the fixture repo and the scripted pool.
- **Dash 2 — the pointing gesture (G3):** composer refs on the wire, question-post refs, verified-mention preamble, outline seeding. Touches tugdeck + protocol + pipeline; wants an app-test for the composer→post ref round trip alongside the Rust-side pipeline tests.
- **Then measure** with the calibration suite before deciding tier 2 (`repo.search`/FTS). `repo.ls` can ride dash 1 if it stays trivial, or drop until a question actually wants it.

Dash 1 alone makes the incident question answerable three independent ways (repaired scope, read-after-grep, outline). Dash 2 makes it *immediate* — the file the asker pointed at is in the Operator's hands before the first verb runs.
