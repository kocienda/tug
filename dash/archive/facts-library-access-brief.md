# Facts-Library Access — giving the Operator the run of the archive

This brief is the decided design for the next round of Operator work: making the Gazette's Operator genuinely good at covering the breadth and depth of the facts-library it already has. The library itself ([dash/archive/gazette-facts-library-brief.md](archive/gazette-facts-library-brief.md)) shipped whole — recorders at every owning site, FTS over the rendered text, the desk's first verbs. What this brief fixes is the *access story*: a 2026-08-13 read of `feeds/operator.rs`, `feeds/gazette_agent.rs`, and the ledger reads behind them found that the Operator is set up as a search tool over what is actually a structured, browsable, time-ordered record — and that it is asked to follow rules it has not been given the inputs for.

The library's doctrine stands unchanged: *gazette prose locates, ledgers confirm*. Every piece here is about the confirming half reaching more of the library, faster, with fewer wasted rounds.

## What the read found

Six gaps, ordered by how hard they bite.

**1. The Operator has no clock.** `compose_retrieve_input` (`operator.rs:919`) is exactly `QUESTION` + `RECENT GAZETTE POSTS` — nothing tells the model what *now* is. Five verbs take `since_ms`/`until_ms` in epoch milliseconds and `git.log` takes `since`/`until`, so a question like "since yesterday morning" requires epoch arithmetic from a model with no reference point; its only anchor is squinting at the newest scrollback post's raw `at_ms`, which fails outright on an empty channel. The answer side is worse: `OPERATOR_ANSWER_INSTRUCTIONS` demands prose times — "yesterday at 4:12pm", "on Aug 9", never raw epoch ms — and "yesterday" is not computable from a number with no *today*. We wrote a conversion rule and withheld the conversion's inputs.

**2. Round one is spent on discovery.** Most fact verbs sharpen dramatically with a `session_id`, and the only way to get one is to spend a verb on `sessions.list`. With `MAX_RETRIEVAL_ROUNDS = 2` and the second round `forced`, "what did I ask in the tugcast session yesterday" burns its whole first round learning an id, then answers from one forced follow-up. The model starts every question knowing nothing about the sessions the questions are almost always about.

**3. The library can only be searched, never browsed.** `facts.search` does `req_str(args, "query")` — every entrance to the fact base is a successful FTS5 match. `facts.window` needs a `fact_id` only a search hit can supply; `session.prompts` is kind-locked to prompts. So "show me every test run yesterday", "what happened in session X this morning", "which commits landed this week" have no direct expression: the model must invent a search term and hope it collides with the rendered text. And `search_facts` orders by `bm25(facts_fts)` (`session_ledger.rs:5962`), so even a lucky term returns the 30 most *relevant* facts, not the most recent — wrong for essentially every "what happened lately" question. The ledger already knows how to list (`list_facts_for_session_since` feeds every Reporter wake); no verb exposes listing.

**4. The facts' depth never reaches the model.** `fact_json` (`operator.rs:339`) returns `id / at_ms / kind / session_id / subject / text` — the `payload` column is deliberately absent, and the doc-comment's reason is principled ([P02]: one rendering everywhere, and a prompt's payload runs to kilobytes). But the flattening costs real answers: a commit fact renders as `commit a1b2c3d "msg" — 3 file(s)` with the file list *right there in the payload* and unreachable, so "which files were in that commit" detours through `git.show` and spends a verb re-fetching what the library already holds. Test-run facts hold pass/fail/skip totals, shell facts hold exit code/cwd/route, compaction facts hold pre/post tokens — all recorded, none served. `session_prompts` already breaks the pattern deliberately (its comment: `text` is "the wrong thing to answer this question with") and reads the payload for the full prompt; that instinct is correct and is exercised in exactly one place.

**5. The answer voice rule names a thing no verb supplies.** `OPERATOR_ANSWER_INSTRUCTIONS` says to name a session "by its project and callsign or by its title" — and no verb result carries a callsign. `sessions_list` (`operator.rs:442`) serializes `session_id / incipit / project_dir / created_at_ms / last_used_at_ms / turn_count / state`; the row's `tag` (the minted `adjective-noun` callsign) and `synopsis` (the rolling one-line description, [D132]) are both sitting on `SessionRow` and both omitted. The model is instructed to write names it has never been shown.

**6. The model queries the FTS blind.** The retrieve instructions list the fact kinds but never show what a fact's rendered `text` *looks like*, and FTS matches against `subject` + `text` only. The renderings are specific — `$ cargo nextest run → ok`, `tests: nextest — passed (302 passed, 0 failed)`, `commit a1b2c3d4e5f6 "subject" — 3 file(s)`, `prompt: "…"` — so a model searching "failing tests" misses rows whose text says `failed`, and one searching "ran the build" misses `$ just build-app`. A few example lines in the prompt is the cheapest hit-rate improvement available.

What the read did *not* find: machinery problems. The verb executor's postures are right and stay untouched — read-only structurally, per-verb caps, `plain_arg` flag-refusal, errors returned as text the model reads and corrects, privacy exclusion inside the SQL (`not_private!`), and the prompt↔executor verb list pinned by test (`operator.rs:2247`). Every piece below rides that machinery.

## The pieces

### P1 — A clock

Both compose functions (`compose_retrieve_input`, `compose_answer_input`) gain one line before the question:

```
NOW: 1786572090962 (Thursday, August 13, 2026, 2:41pm PDT)
```

Epoch ms first because that is the unit the verb args and every `at_ms` in the results speak; the human rendering second because that is what the answer's prose-time rule converts *to*. Local time (chrono is already a workspace dep), since the person asking speaks local — the ledgers' UTC internals are not this line's business. This single line makes `since_ms` arithmetic possible on the retrieve side and "yesterday at 4:12pm" computable on the answer side.

### P2 — A session roster in the retrieve turn

`compose_retrieve_input` gains a `SESSIONS:` section — a compact roster rendered from the same `list_sessions_recent` read `sessions.list` uses (which already excludes private sessions in its SQL), newest-first, one line per session:

```
- horizon-lark (a1b2c3d4…) [active] /Users/ken/src/tugtool — "Gazette operator access work" — last used 2:12pm today
```

Callsign, short id, state, project dir, title-or-incipit, synopsis when present, last-used as a human time (the roster has P1's clock to lean on). Bounded — active sessions plus the most recently used handful, with per-line caps — because it is context, not a verb result; `sessions.list` remains the verb for going deeper (filters, the full 50). The payoff is a whole round: questions that name a session by project or topic resolve to an id *before* the first verb is chosen, so round one does retrieval instead of discovery.

### P3 — `facts.list`: browsing the kind × session × time grid

One new verb, joining the table under the same caps machinery:

| Verb | Args | Backing | Cap |
|------|------|---------|-----|
| `facts.list` | all optional: `kind`, `session_id`, `since_ms`, `until_ms` | new ledger read: plain filtered `SELECT` over `facts`, no FTS, newest-first | 30 facts |

This is the missing direct expression for "every test run yesterday" (`kind=test_run, since_ms=…`), "what happened in session X this morning" (`session_id, since_ms`), "commits this week" (`kind=commit`). The division of labor becomes clean and teachable: **`facts.search` answers "find facts about X" (relevance-ranked); `facts.list` answers "what happened" (time-ordered)** — and the retrieve instructions say exactly that sentence. The new ledger read is `list_facts_for_session_since` generalized: every filter optional, an `until_ms`, newest-first, private-session exclusion via the same `not_private!` macro every facts read carries.

A separate verb rather than making `facts.search`'s `query` optional: the two orderings (bm25 vs recency) are different tools, and a query-optional search that silently switches sort order is a trap for the model choosing it.

### P4 — Depth: a curated `detail` per kind

`fact_json` keeps `text` as the one canonical rendering ([P02] holds — search, the wake section, and the verbs keep describing every fact identically) and gains a `detail` object: a **curated per-kind projection of the payload**, not a raw passthrough. Composed in `facts_library.rs` beside `render_text` so the projection and the rendering evolve together:

- `commit` — full first line of the message, branch, the file list with numstat (capped at a few dozen paths; the count when longer)
- `test_run` — runner, verdict, passed/failed/skipped totals, the classified command
- `shell` — full command (to the recorder's cap), route (`user`|`claude`), ok/exit code, cwd
- `session.compacted` — trigger, pre/post tokens
- `prompt` — fuller text, capped at `PROMPT_MAX_CHARS` (500) like `session.prompts` serves; the kilobyte payload is exactly why this is a projection and not the payload
- lifecycle kinds — whatever small fields the payload holds (project_dir, old/new name, detail)

Every fact verb serves it (`facts.list`, `facts.search`, `facts.window`). Result-size math stays sane: 30 facts × a capped detail is well inside what one verb round already returns for `git.show` (16 KB). This closes the "which files were in that commit" detour: the library answers from what it recorded, and `git.show` returns to being the *confirming* source for diffs and messages rather than a workaround for withheld data. As with the file-list cap, anything elided is elided visibly (a count, an ellipsis) — never silently.

### P5 — The roster's data reaches `sessions.list` too

`sessions_list`'s JSON gains `tag` and `synopsis`. The answer voice rule ("project and callsign, never a bare UUID") becomes followable from the verb results themselves, and the synopsis is a free gift for "which session was the one about X". Two fields off a row already in hand.

### P6 — The instructions catch up

`OPERATOR_RETRIEVE_INSTRUCTIONS` changes in three ways, each pinned by the contract test the way every existing instruction clause is (`gazette_agent.rs` tests):

- **`facts.list` joins the verb table** with the search-vs-list sentence from P3. (`VERB_NAMES`, the dispatch table, and the instruction list stay pinned against each other by the existing test.)
- **Three example fact renderings** so FTS queries are composed against what the text actually says — one shell, one test_run, one commit line, verbatim from `render_text`'s formats.
- **The NOW and SESSIONS sections are named**, the way the Reporter's instructions name `SETTLED FACTS SINCE YOUR LAST POST:` — a section the composer prints under a header the model was never told about is half wasted.

`OPERATOR_ANSWER_INSTRUCTIONS` needs only awareness that verb results now carry `detail` (cite from it; it is exact) — the prose-time and callsign rules stand, newly satisfiable.

## What stays out

- **No raw payload passthrough.** `detail` is a projection with per-kind caps. The payload column stays the recorders' structured form, not a wire format.
- **No third retrieval round.** The roster exists to make two rounds enough; raising `MAX_RETRIEVAL_ROUNDS` is a latency decision to revisit only if the calibration read (below) shows two well-fed rounds still starving real questions.
- **No new FTS surface.** `facts.list` is a plain filtered SELECT; the FTS index and its bm25 ranking are untouched.
- **No Reporter changes.** The wake diet, `FACTS_SECTION_MAX`, ref validation — all out of scope. This brief is the desk, not the newsroom.
- **No new fact kinds, no recorder changes** beyond the detail projection living beside `render_text`.
- **No privacy posture changes.** Every new read carries the same in-SQL exclusion; the roster renders from a read that already excludes private sessions.

## Verification items (for `/devise`)

- **Roster bounds**: how many sessions (all active + N recent?), per-line caps for title/synopsis, and whether an empty ledger renders a `(no sessions)` line so the section header is always present for the contract test to pin.
- **NOW formatting**: the exact strftime shape, and confirming chrono `Local` resolves the right zone under the launchd-spawned tugcast (the ledgers-are-UTC memory is about log lines, not `TZ`).
- **The `facts.list` ledger read**: generalize `list_facts_for_session_since` in place vs. a new `list_facts` — whichever leaves the wake's callers untouched; `until_ms` semantics; newest-first confirmed against the wake's oldest-first expectations.
- **`detail` caps per kind**, especially the commit file-list cap and whether numstat rides each path or totals only; and whether `facts.window`'s 41-row worst case × detail needs a tighter window cap.
- **Prompt-size audit**: the retrieve turn grows by NOW + roster + examples — measure the composed input against a populated ledger and confirm it stays well under the job's practical budget.
- **Contract-test coverage**: every new section header, the search-vs-list sentence, the example renderings, and `facts.list` in the verb-pinning test — following the existing "the string Rust prints is the string the model was told about" doctrine.
- **Worked examples re-run**: the four questions the library brief called out ("what did I ask yesterday", "what tests failed this morning", "when did I last clear that session", "what did we commit Tuesday") plus the new browsable ones ("what happened in session X this morning", "every test run yesterday") answered in the live app, watching which verbs the model actually picks now that listing exists.

## Phasing sketch

1. **The clock and the roster** (P1, P2, P6's section-naming) — compose-function and instruction changes, contract tests; the model's situational awareness fixed first because everything else reads better through it.
2. **The list verb** (P3) — ledger read, verb, dispatch, instruction table row, tests.
3. **Depth** (P4, P5) — the detail projection beside `render_text`, `fact_json` and `sessions_list` extended, caps tested.
4. **The read** — the worked-examples pass against the live app, watching verb selection and answer quality; any instruction tuning that reading demands.

Each phase is independently shippable; phase 4 is a human read, exactly as the library brief's Reporter phase was.
