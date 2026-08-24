# The Feed — an app-wide channel with the Herald, the Operator, and You

This brief is the decided design for the **Feed**: a Tug-wide social-feed-style channel that narrates the work happening across all sessions, renders in a new sidebar card, and hosts a question-answering agent grounded in Tug's ledgers. Every decision below is settled unless marked as a verification item. File/symbol references were confirmed against the tree as of 2026-08-06.

## Vision

The Feed is an overarching reader/monitor of all session work going on in Tug. A summarizer (the **Herald**) watches the actual transcript traffic and posts digest-sized write-ups of the work as it happens, coalescing them into a new unified transcript. A question-answering agent (the **Operator** — think old-timey switchboard, or the Matrix) sits behind a prompt-entry box at the bottom of the card and answers questions about what happened — "what was that session where we did *blah blah*?", "what's the CSS file we edited yesterday that changed the border color?", "what was that commit two weeks ago that did *blah blah*?" — by reading the feed, querying the feed's full history, and consulting Tug's ground-truth ledgers.

Another way of seeing it: the Feed is a *social network feed for your project* with exactly three contributors, and one of them answers the phone.

## The channel model

Three authors, one transcript. Every row in the channel is a post by one of:

| Author | Who | Icon |
|--------|-----|------|
| `herald` | The summarizer. Posts digests of session work as it happens. | lucide `newspaper` |
| `operator` | The Sonnet-based question-answering agent. Posts answers (and only answers — it speaks when spoken to). | the `operator` glyph (bot head with headset and boom mic) in `tugdeck/src/components/tugways/tug-icons.tsx` (`operatorIconNode`, ~line 41) |
| `user` | The human. Posts questions/messages via the card's prompt-entry box. | the same user icon the Session card uses |

### Post schema

Conceptual row shape (exact DDL at `/devise`): `author ∈ {herald, operator, user}`, timestamp, body, `session_id` (required on Herald posts — every digest is clickable provenance back to its source session), and a typed **`refs`** list:

```
refs: [{ kind: "session" | "file" | "commit" | "plan" | "brief", target: string }]
```

The card renders refs as clickable chips: session → raise the Session card, file → file view, commit → the git surfaces, plan/brief → the roadmap doc. The Herald emits body + refs in a structured envelope validated Rust-side; salience (*which* refs make the post) is the model's editorial call, but the tap must preserve paths and SHAs **verbatim** in the buffered context — a summarized-away SHA can't be linked.

## The Herald

The Herald is a **first-order reader of the real transcript traffic** — not a derivative of Pulse, not a re-teller of anyone's re-telling.

### Wake structurally, post editorially

The division of labor is the load-bearing design decision. Half the moments worth posting about are *semantic* ("investigation results came back," "a brief finished being written," "/devise moved from canvassing to writing the plan") — hard-coding detectors for those in Rust would be brittle and forever behind the skills' evolution. So:

- **Rust decides when to wake the Herald** — cheap, structural moments only: a turn completed; a session ended; a token-usage or duration threshold crossed; and the **sitrep timer** — 3–5 minutes of continuous activity in a session since its last post (starting value; tuned by the calibration harness below). An *idle* session never triggers a wake — silence isn't news. Between wakes, the tap buffers each session's frames. The spike (below) showed the sitrep timer is the **dominant** wake in practice — real turns routinely run longer than the timer, so turn-end functions as a *flush* (and as the "ready for the user to look in" signal) rather than the primary cadence.
- **The model decides whether and what to post.** Each wake hands Sonnet the session's buffered frames, the **wake reason** (`turn-end` / `sitrep-timer` / `session-end` / threshold — the model uses it well, e.g. writing wrap-up posts on session end), plus the Herald's own last few posts for that session, with the editorial rubric below — and "post nothing" is a first-class output. Dedup falls out of the same mechanism: the model sees what its last post already covered (the Pulse re-seed-from-ledger-tail pattern). Granularity is thereby a *prompt-tunable editorial policy*, not a Rust event taxonomy.

### The editorial rubric

The rubric is: **tell the human things about their sessions they're worrying about anyway.** Post-worthy moments include:

- An agent (or set of agents) returned with investigation results on an open matter.
- A `/devise` finished canvassing the code and started writing its plan.
- A plan step finished during an `/implement` run.
- A session crossed a token-usage or elapsed-time threshold.
- A brief finished being written.
- A session finished a turn and is ready for the user to look in — with a summary of what was done.
- A commit landed — post a short summary.
- Work is still cooking — a sitrep.

Posts are per-session (each links back to exactly one session); concurrent sessions simply interleave in the feed — that *is* the social-feed feel. No cross-session digest in v1.

### Bridge topology

- **Input**: the Herald's own independent tap on the `CODE_OUTPUT` broadcast — the same spliced frames every deck receives, with `tug_session_id` riding each frame. Identical tap architecture to `feeds/pulse.rs`, instantiated a second time with its own allowlist (user prompts, assistant text, tool activity, session lifecycle, turn results with usage — finalized during implementation against the wake/rubric needs).
- **No daemon.** Because each wake is self-contained (buffer + last-K-posts in, post-or-nothing out), the Herald needs no tugpulse-style supervised subprocess. It is a **`herald-post` job on the SharedAgent pool** (see "One agent spec, three jobs" below). The tap/buffer/wake bridge in tugcast is the only genuinely new plumbing.
- **Inherited Pulse-bridge behaviors**: replay-bracket muting (everything between `replay_started`/`replay_complete` is muted, so reconnect floods never re-narrate history) and lagging-receiver frame drops (narration never backpressures work).
- **Invariant — the feed is not in the Herald's diet**: the Herald's input is the `CODE_OUTPUT` tap; Herald/Operator/user posts travel on the Feed's own FeedId and never enter that tap. No feedback loop is possible by construction, exactly as with Pulse.
- **Invariant — one-way isolation**: inherited from Pulse's law. Nothing in the Feed subsystem writes toward any work session. The Herald's outputs are the feed ledger, the feed broadcast, and tracing; the Operator answers only into the feed channel.
- **Scope**: the Herald narrates what crosses `CODE_OUTPUT` for this tugcast instance — session work. Work done entirely outside any session is not narrated. This is deliberate.
- **Cost is explicitly a non-concern**: the sessions the Herald narrates run Opus/Fable; a Sonnet Herald is noise in comparison. Cadence is an editorial question, not an economic one.

### The calibration harness (part of the feature, built first)

Before the live bridge is wired, build an **offline transcript-replay rig**: run real session JSONL (megabytes of it exist under `~/.claude/projects/`) through the tap-and-rubric pipeline — segment into wake windows, call the `herald-post` job per window — and render the feed the Herald *would have* posted. We read it and tune the rubric, the wake thresholds, and the 3–5 minute sitrep number against real work instead of guessing. Same pattern as the bonsai scribe eval; it derisks the feature's biggest unknown (is the Herald pleasant to live with?) for the cost of an offline script.

**Spike results (2026-08-06, validated)**: a first cut of this rig replayed two real sessions through Sonnet with the rubric above — a ~105-minute `/implement` run (19 wakes → 15 posts + 4 correct silences) and a ~40-minute interactive fix session (9 wakes → 7 posts + 2 correct silences). Verdict: the wake-structurally/post-editorially split works as designed. Posts were specific and rubric-shaped (plan steps landing with commit SHAs, spike findings with real numbers, test totals, session wrap-ups); the last-K-posts mechanism produced correct "no post" decisions on already-covered material; refs stayed verbatim (no invented paths/SHAs observed); an idle gap between turns correctly produced no wake. Findings folded into this brief: the sitrep timer dominates (turn-end is a flush), and the wake reason belongs in the job input. The 4-minute timer read well — one post per ~5–7 minutes of active work.

## The Operator

The Operator answers questions from the card's prompt-entry box. Architecture:

### Verbs execute Rust-side

**The model never gets shell or file access.** The Operator emits *requests* for named verbs; tugcast executes them read-only and packs the results into the next turn. This keeps [P01] intact (the job table stays auditable, the model can't wander), makes read-only-ness structural rather than promised, and keeps every verb's output capped so the self-contained turn stays packable.

### Two jobs, a bounded retrieval loop

1. **`operator-retrieve`** — input: the user's question + the card's recent scrollback. Output: structured JSON — a list of verb invocations with arguments. tugcast executes them.
2. **`operator-answer`** — input: question + scrollback + verb results. Output: the answer post — plus optionally *one* follow-up verb list if the results were insufficient (e.g. feed search located the day; now it wants the commit). **Hard cap: two retrieval rounds**, then it answers with what it has and says what it couldn't confirm.

The rejected alternative — handing the worker `--allowedTools` for free iteration — fights the SharedAgent contract (unbounded turn duration vs. the `JobSpec` timeout ceiling) and would make tool policy a second audit surface. The plan/execute/answer shape keeps latency bounded and the whole exchange scorable against a corpus later.

[P05] holds: each question is self-contained; context rides the call; no conversational worker state. If multi-turn follow-up conversation later proves necessary, that is a redesign away from SharedAgent, not a tweak — deliberately out of scope.

### The verb table

All verbs are read-only, executed by tugcast, with capped/excerpted output:

| Verb | Input | Output |
|------|-------|--------|
| `feed.search` | query terms; optional date range / author / session_id | matching posts: id, ts, author, session link, excerpt |
| `feed.window` | post id, ±n | surrounding posts — read the narrative around a hit |
| `sessions.list` | date range; active/ended filter | session rows: id, title/incipit, started/ended, status |
| `session.prompts` | session_id; optional query | that session's user prompts (the "what did I ask" layer) |
| `changes.for_session` | session_id | files touched, op kinds, proof class — from `changes.db` |
| `changes.for_path` | path/glob, date range | which sessions/commits touched it |
| `git.log` | `--grep` text and/or pickaxe `-S`/`-G` content; path filter; date range; n | commits: sha, date, subject, files |
| `git.show` | sha; optional path filter | message + capped diff |
| `repo.grep` | pattern; path scope; n | current-state matches — "which brief/plan/law says X" over dash/, tuglaws/, and the tree |

Worked example — "what's the CSS file we edited yesterday that changed the border color": `changes.for_path("**/*.css", yesterday)` locates candidates with proof-class certainty; `git.show` with a path filter confirms which one touched `border-color`. Neither step trusts Herald prose — the feed only narrows *when* and *which session*. **Feed prose locates; ledgers confirm.**

## One agent spec, three jobs

One Sonnet **`AgentSpec`** on the SharedAgent pool (`tugrust/crates/tugcast/src/shared_agent.rs`) carries the whole feature's model traffic as three fixed jobs: **`herald-post`**, **`operator-retrieve`**, **`operator-answer`**. This is exactly what the module's contract anticipates ("standing up a second agent on a different model means constructing a second `AgentSpec`, not writing new machinery"), and it means zero new process-supervision code.

**Model**: Sonnet for both personas, wired as a single tugbank default in the feed's domain (e.g. `dev.tugtool.feed`/`model`), following the `scribe_model` pattern — resolved in `main.rs`, falls back to `sonnet` by name, read through a closure at worker spawn so a settings change applies without restart (the mechanism `shared_agent.rs` already documents).

## Transport: reclaiming `TUG_FEED` (0x70)

The reserved FeedId is genuinely free — `FeedId::TUG_FEED = 0x70` (`tugrust/crates/tugcast-core/src/protocol.rs:134`, TS mirror `tugdeck/src/protocol.ts:56`) has a name mapping, a byte-value test, and zero consumers. The archived tug-feed plan (`dash/archive/tug-feed.md`) that reserved it was never built and its needs were met elsewhere; this feature is closer to the *original* "tugfeed" meaning (a stream in the deck) than that plan was. Reclaim the id: retire the "reserved for Phase T3+" comment, keep the byte, carry the Feed channel on it. Upstream (user → tugcast) traffic for user posts/questions either shares 0x70 bidirectionally or takes a sibling query id — decided at `/devise` following the existing `USAGE`/`USAGE_QUERY` and `SHELL_OUTPUT`/`SHELL_INPUT` precedents.

## Persistence

- **Durable app-scoped ledger**, one per tugcast instance (the Pulse scoping), holding the full channel history — all three authors' posts, bodies and refs. Writable opens go through `tugcore::ledger_db` like every ledger (enforced by `no_ad_hoc_ledger_opens`). Whether this is a new database or a table in an existing per-instance ledger is a `/devise` decision; it is **not** the capped rolling log Pulse uses — history is the point.
- **The card renders a window; the ledger keeps everything.** The Feed card ages out rows past a reasonable scrollback — start at **50** rows and tune by feel. Aging out is a *render window*, never a deletion.
- **The Operator queries the full ledger** (`feed.search`/`feed.window`), unbounded by the card's window — that is what makes "what was that commit two weeks ago" answerable.

## The Feed card

- **`layoutRole: "sidebar"`** under the taxonomy shipping in `dash/layouts-rework-plan.md`. That plan explicitly anticipates this card — its non-goals defer "the third sidebar card (a future feature; the registry-driven Layouts controls make it appear for free when it registers)". The Feed card is that third card: on registration it inherits the Layouts section controls, side toggles, bilateral/stacked rails, and the equal-resize allocator for free.
- **Hard sequencing dependency**: the Feed card lands after layouts-rework ships the sidebar taxonomy.
- **Layout**: transcript above, prompt-entry-style box at the bottom for user posts/questions to the Operator. Both must read well at rail width, including stacked on the same side as Lens or Jots with the draggable seam. Refs render as chips on each post.
- **Iconography**: as in the channel-model table — lucide `newspaper` (Herald), the existing `operator` glyph (Operator), the Session card's user icon (You).

## What this is not

- Not the archived hooks-based tug-feed (`dash/archive/tug-feed.md`): no plan-step correlation, no hook capture layer, no `.tugtool/feed/feed.jsonl`. The Herald reads the live `CODE_OUTPUT` broadcast, full stop.
- Not a replacement for Pulse. Pulse stays as-is; neither consumes the other.
- Not a control surface. Nothing in the Feed writes toward a work session; the Operator cannot drive work.
- Not a conversational chat with memory: Operator turns are stateless by design.
