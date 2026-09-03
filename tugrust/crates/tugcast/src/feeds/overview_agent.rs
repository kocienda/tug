//! overview_agent — the Overview's model traffic: one Sonnet [`AgentSpec`] on
//! the SharedAgent pool, operated against three fixed jobs.
//!
//! The whole feature's model usage is `observer-post`, `operator-retrieve`,
//! and `operator-answer`. That is exactly the extension `shared_agent`
//! anticipates — "standing up a second agent on a different model means
//! constructing a second `AgentSpec`, not writing new machinery" — so there is
//! no process supervision here, only a job table and the knobs that tune it.
//!
//! ## The division of labor
//!
//! Rust decides *when* to wake the Observer; the model decides *whether and
//! what* to post. Half the moments worth posting about are semantic
//! ("investigation results came back", "a plan step landed"), and hard-coding
//! detectors for those would be brittle and forever behind the skills'
//! evolution. So the wake is structural and cheap, and "post nothing" is a
//! first-class output of the job. Granularity is thereby a prompt-tunable
//! editorial policy rather than a Rust event taxonomy.
//!
//! ## Why every number here is a knob
//!
//! Cadence is a question about feel, and feel is not answerable from a desk.
//! Each tuning value is a tugbank default read through a closure at the moment
//! it is used, never cached at startup, so turning one applies without a
//! restart — the `pulse_enabled` / `scribe_model` pattern in `main.rs`.
//!
//! One-way isolation, inherited from Pulse's law: nothing in the Overview
//! subsystem writes toward any work session.

// The knob surface is authored ahead of the bridge and the Operator pipeline
// that read it: the model and worker-cap keys have consumers today, the
// cadence and window keys are read when the Observer bridge lands. Suppress
// dead-code for the phased rollout, the same way `session_ledger.rs` and
// `path_resolver.rs` do. Declaring the whole table in one place is the point —
// a knob invented later next to its reader is a knob nobody knows exists.
#![allow(dead_code)]

use std::sync::Arc;

use tokio::time::Duration;

use crate::shared_agent::{AgentSpec, JobSpec, SharedAgentPool};

// MARK: - Configuration

/// Tugbank domain for every Overview default. Mirrored deck-side by the
/// Overview store, which reads `card_rows` off the DEFAULTS feed.
pub const OVERVIEW_DOMAIN: &str = "dev.tugapp.overview";

/// Full model id or alias for all three jobs.
pub const MODEL_KEY: &str = "model";

/// Total worker cap for this pool.
pub const MAX_WORKERS_KEY: &str = "max_workers";

/// Seconds of continuous session activity, since that session's last post,
/// after which the Observer wakes with `sitrep-timer`.
pub const SITREP_SECS_KEY: &str = "sitrep_secs";

/// How many of the Observer's own prior posts for a session ride each wake.
pub const LAST_K_POSTS_KEY: &str = "last_k_posts";

/// Cumulative turn-usage tokens since the last post that trigger a wake.
/// Zero disables the threshold entirely.
pub const TOKEN_WAKE_TOKENS_KEY: &str = "token_wake_tokens";

/// Per-session buffer cap, in frames.
pub const BUFFER_MAX_FRAMES_KEY: &str = "buffer_max_frames";

/// How much history the card OPENS WITH, in rows — the `limit` on its
/// mount-time read, and on each older page it asks for afterwards.
///
/// It was a render window until the card learned to scroll back; now the
/// reader can page past it, and what bounds the list is the deck's own
/// `OVERVIEW_MAX_ROWS` ceiling. Never a deletion in either reading — the
/// ledger keeps everything and the Operator searches all of it. The name
/// outlives the change, which is why the meaning is written down here.
pub const CARD_ROWS_KEY: &str = "card_rows";

/// The model both personas run on.
///
/// An alias rather than a pinned id, matching the `scribe_model` default: the
/// jobs here are prose work with a human reading the output, so tracking the
/// current Sonnet is what we want, and the knob is there for pinning.
pub const DEFAULT_MODEL: &str = "sonnet";

/// Room for a Observer post, an Operator retrieve, and an Operator answer to
/// be in flight at once.
///
/// Three rather than the Haiku pool's two because `JobClass::of` maps every
/// non-classify job to one lane, so all three of these share it. A
/// `observer-post` may hold a worker for its full two-minute ceiling, and a
/// user waiting on an answer must not queue behind narration nobody is
/// waiting for.
pub const DEFAULT_MAX_WORKERS: usize = 3;

/// The dominant wake, and the number that decides how the channel feels.
///
/// Ninety seconds, chosen by reading three offline replays of the same real
/// session side by side rather than by reasoning about it: 90 gave a post
/// roughly every three minutes, 120 every five, 180 every twelve. The channel
/// at 180 read as a log somebody skims later; at 90 it read as someone telling
/// you what is happening. Cadence is a question about feel, and this is the
/// answer the reading gave.
///
/// A faster value is worth trying if this proves too quiet in practice — the
/// number is a tugbank default, so turning it needs no rebuild and no restart,
/// and `overview-replay --sitrep-secs` reads any candidate against a real
/// transcript first.
pub const DEFAULT_SITREP_SECS: i64 = 90;

/// How much of its own recent voice the Observer sees per wake.
///
/// This is the entire dedup mechanism: the model is shown what it already
/// said about this session and declines to repeat it. Nothing compares text.
pub const DEFAULT_LAST_K_POSTS: usize = 5;

/// Off by default — the sitrep timer and turn ends already cover the ground,
/// and a token threshold that fires mid-thought is noise.
pub const DEFAULT_TOKEN_WAKE_TOKENS: i64 = 0;

/// Per-session frame cap before the oldest are elided from the wake input.
pub const DEFAULT_BUFFER_MAX_FRAMES: usize = 256;

/// Byte ceiling on one wake's buffered frames, alongside the frame cap.
/// Fixed rather than a knob: it exists to bound one turn's input, and the
/// frame cap is the dial worth turning.
pub const BUFFER_MAX_BYTES: usize = 256 * 1024;

/// Starting render window for the card.
pub const DEFAULT_CARD_ROWS: usize = 50;

// MARK: - The job table

/// Nothing user-blocking waits on a Observer post, so its ceiling is a
/// quality bound rather than a latency budget: a digest that needs two
/// minutes may take them.
const OBSERVER_POST_TIMEOUT: Duration = Duration::from_secs(120);

/// Retrieval is a short structured answer — a list of verb calls — so a long
/// wait here means something is wrong rather than something is thorough.
const OPERATOR_RETRIEVE_TIMEOUT: Duration = Duration::from_secs(30);

/// Someone is watching a pending row while this runs, but the answer is the
/// product; the card shows pending state rather than racing a deadline.
const OPERATOR_ANSWER_TIMEOUT: Duration = Duration::from_secs(120);

const OBSERVER_POST_SLOW: Duration = Duration::from_secs(60);
const OPERATOR_RETRIEVE_SLOW: Duration = Duration::from_secs(10);
const OPERATOR_ANSWER_SLOW: Duration = Duration::from_secs(45);

pub static OVERVIEW_AGENT_JOBS: &[JobSpec] = &[
    JobSpec {
        name: "observer-post",
        timeout: OBSERVER_POST_TIMEOUT,
        slow: Some(OBSERVER_POST_SLOW),
        instructions: OBSERVER_POST_INSTRUCTIONS,
    },
    JobSpec {
        name: "operator-retrieve",
        timeout: OPERATOR_RETRIEVE_TIMEOUT,
        slow: Some(OPERATOR_RETRIEVE_SLOW),
        instructions: OPERATOR_RETRIEVE_INSTRUCTIONS,
    },
    JobSpec {
        name: "operator-answer",
        timeout: OPERATOR_ANSWER_TIMEOUT,
        slow: Some(OPERATOR_ANSWER_SLOW),
        instructions: OPERATOR_ANSWER_INSTRUCTIONS,
    },
];

/// Build the pool. Spawns nothing — the first job of a class is what spawns
/// its worker, so an instance where nobody opens the Overview pays nothing.
pub fn build_pool(
    model: Arc<dyn Fn() -> String + Send + Sync>,
    max_workers: usize,
) -> Arc<SharedAgentPool> {
    SharedAgentPool::new(
        AgentSpec {
            name: "overview",
            model,
            jobs: OVERVIEW_AGENT_JOBS,
            max_workers,
        },
        Arc::new(crate::shared_agent::ClaudeAgentWorkerSpawner),
    )
}

// MARK: - Instructions

/// The Observer's wording.
///
/// The rubric is carried verbatim from the brief because it is the editorial
/// contract, not a paraphrase of one: these are the moments a person working
/// in Tug is already wondering about, and the list is what makes the model's
/// judgment match theirs.
///
/// Silence is bounded on purpose. An early draft made "post nothing" both
/// emphatic and open-ended, and the model read the coding-flavored bullet list
/// as the whole beat: a session that answered a question and finished its turn
/// got no post, because the subject was not code. That is backwards. A turn
/// ending IS the news — the person stepped away and this is how they learn what
/// came back — so the wording now names the two cases silence is for (an empty
/// window, or a repeat of the last post) and requires a post outside them.
/// Whether the work was worth doing is not the Observer's call; whether it
/// happened is.
///
/// The first repair overshot into the opposite failure. Telling the Observer to
/// post "even when the subject is nothing to do with their code" handed it the
/// contrast, and it performed it: the next post opened "Answered a physics
/// question, not code:". Defining the beat by what it is not guarantees that
/// framing reaches the body. So the wording no longer mentions code as a
/// baseline anywhere, and the voice rule forbids the move outright — report the
/// work, never a judgment about which kind of work it was.
///
/// Length is stated as a budget because an adjective did not hold. "A few
/// sentences at most" produced 100-to-130-word posts that walked the reasoning
/// and re-gave the answer the session had already given — the content, not a
/// summary of it. A countable limit plus the rule that the post exists to get
/// the reader to the session, not to stand in for it, is what actually binds.
/// The budget is 200 characters of prose, and it is a *prose* budget: paths,
/// shas, and session names the body must spell exactly are excluded from the
/// count, so precision is never what the budget squeezes out. `settle` clamps
/// the same measure Rust-side (`clamp_post_body`), so a model that ignores the
/// budget still cannot put a long post in the channel.
///
/// The budget's size was never the problem with truncation; nothing told the
/// model to compose sentences that FIT it. So the wording now demands complete
/// sentences within the budget — end sooner rather than write past it — and
/// `clamp_post_body` follows the same principle when it does fire, cutting at a
/// sentence boundary so a clamped post still ends on a period.
///
/// The wording asks for what the wording can get, which is a shape: two short
/// sentences, ending sooner as the budget nears. What it cannot get is the last
/// sentence landing exactly on 200, because a model emits tokens and cannot
/// count the characters in them as it composes. That residual overshoot is
/// answered Rust-side by `OBSERVER_PROSE_GRACE`, not by more insistent wording
/// — and the grace is deliberately absent from these instructions, since a
/// number the model is told is a number it composes toward.
///
/// Backticks are asked for rather than hoped for. The body renders as markdown,
/// where a backticked name is a code span the annotator resolves — clickable by
/// being backticked — and the model was already emitting them by habit, which
/// made the payoff an accident. One sentence makes it a contract. Nothing more
/// of markdown is invited: lists and headings would only change how a
/// 200-character notice looks in a narrow rail.
///
/// Two things here are load-bearing downstream and must not drift. The output
/// is strict JSON with `{"post": null}` as a first-class answer — silence is
/// the safe failure mode, and a repaired or partial post is worse than none.
/// And refs must quote their targets **verbatim** from the frames, because a
/// path or sha the buffered context never contained is validated away Rust-side
/// rather than rendered as a chip that goes nowhere.
const OBSERVER_POST_INSTRUCTIONS: &str = "\
You are the Observer for the Overview, a channel that narrates the work happening across a developer's coding sessions. You are shown one session's recent activity and decide whether it is worth posting about, and if so, what to say.

Your rubric: tell the human things about their sessions they are worrying about anyway. These are examples of moments, not a list of subjects — whatever the session was doing is what you report:

- An agent (or set of agents) returned with investigation results on an open matter.
- A /devise finished canvassing the code and started writing its plan.
- A plan step finished during an /implement run.
- A session crossed a token-usage or elapsed-time threshold.
- A brief finished being written.
- A session finished a turn and is ready for the user to look in — with a summary of what was done. This one is not optional; see the wake reasons below.
- A commit landed — post a short summary.
- Work is still cooking — a sitrep.

Silence is a real answer, and it has exactly two uses. The first: nothing happened — the window holds only bookkeeping, with no work in it to describe. The second: you would be repeating yourself — you are shown your own last few posts about this session, and saying the same thing again in different words is worse than saying nothing.

Outside those two cases, POST. Whether the work was worth doing is not your call; whether it happened is. A turn that answered a question, explained something, wrote a file, or ran a command has done work, and the person who asked for it is entitled to see it reported. A channel that cries wolf gets ignored, but so does one that stays quiet while the session is plainly busy. Do not narrate every tool call.

The WAKE REASON tells you why you are being asked now. Use it:
- turn-end — the session finished a turn and is ready to look in. ALWAYS summarize what the turn did. A turn ending is itself the news: the person stepped away, and this post is how they find out what came back. The only turn-end you may pass on is one whose window holds no work at all, or one you would only be repeating your last post to describe.
- sitrep-timer — work has been going for a while. Post only if it has gotten somewhere since your last post.
- session-end — the session is over. Write a wrap-up of what it accomplished overall.
- token-threshold — the session has spent a lot. Say what it has been spending on.

Write like a person telling a colleague what happened. One or two sentences, 200 characters of prose at the outside — this is a notice in a narrow rail, not a transcript. The budget counts prose only: file paths, commit shas, and session names you must spell exactly are free, so never vague-up a name to save characters. Concrete and specific: name what was built, what was found, what broke, what was asked and what the answer was. Never narrate your own process.

Every sentence you write must be COMPLETE within that budget. The budget is not a place to be cut off at — it is the room you have, and a sentence that will not fit in what is left is a sentence to shorten or to not begin. As you near the limit, end the sentence sooner; never write past it trusting something to trim the tail, because what that leaves the reader is a half-clause with no end.

Wrap exact names in backticks — paths, commit shas, symbols, commands. The post is rendered as markdown, so `tugdeck/src/main.tsx` reads as the name it is and becomes clickable by being written that way. Backtick every one of them, not the first: a path in backticks and the same path bare are one reference wearing two faces, and the reader has to work out that the difference means nothing. Nothing else about markdown: no lists, no headings, no emphasis.

Spell a commit sha exactly as the facts give it, in backticks, and let the app do the naming. Every sha that checks out against the repository is DISPLAYED as commit:<8ch> — the word supplied, the hash trimmed to eight characters — however you spelled it; and if your own word commit already sits right before the sha, the app shows the hash alone rather than doubling the word, which costs the reader the standard form, so write the bare sha and let the app name it. So write the sentence for meaning, not for the hash's looks: never trim, pad, or reconstruct a sha to make it read well, because the exact characters are what the app verifies and links, and a sha it cannot verify stays plain text exactly as you wrote it.

The post is the summary, never the content. Say what happened and stop — enough that the reader knows where the session got to and can decide whether to look in, never so much that reading the post replaces opening it. If you are explaining how something works, listing every file touched, walking through the reasoning, or reproducing the answer the session already gave, you have written the content instead of the summary. The session itself is one click away; your job is to get them there knowing what they will find.

Report the work; never your view of it. Do not classify what kind of work it was, and never define it by what it was not — no \"not code\", no \"off-topic\", no \"just a question\", no \"only an aside\". Every subject gets the same voice. Open on the specifics — what was asked, what came back, what changed — rather than on a label for the kind of work it was. You are not weighing whether this belonged in the session, and a post that starts by excusing itself has spent its first sentence on nothing.

SETTLED FACTS SINCE YOUR LAST POST: is the durable record of what actually happened — prompts in full, the commands that ran, test verdicts and totals, commits with their SHAs, session lifecycle. It is ground truth, unlike the activity below it, which is whatever the wire happened to carry. Cite a fact's subjects verbatim: a sha, a path, a test count in the facts is exact, and it is the right thing to name. A fact you have already posted about is not news twice — the facts are what settled, not what is new, so a commit you announced last post stays in this section and must not be announced again.

REFS are the clickable provenance on your post. Include one for each file, commit, plan, brief, or session that the post is genuinely about — not everything mentioned. Every ref target MUST be copied EXACTLY as it appears in the activity you were shown: a path spelled differently, or a commit sha you shortened or reconstructed, cannot be linked and will be discarded. If you cannot copy it exactly, leave it out.

Spell a path the way the activity spells it. If the activity says arc/overview-plan.md, the target is arc/overview-plan.md — do not expand it to a full path from the root of the disk, and do not shorten a full path the activity gave you. Copy the characters you were shown. Ref kinds are: session, file, commit, plan, brief.

Answer with JSON and nothing else — no prose before it, no code fence around it.

To post nothing:
{\"post\": null}

To post:
{\"post\": {\"body\": \"...\", \"refs\": [{\"kind\": \"commit\", \"target\": \"a1b2c3d4\"}]}}

An empty refs list is fine. Answer only from the material below.";

/// The retrieval half of the Operator.
///
/// The model never gets shell or file access: it names verbs and tugcast runs
/// them read-only. That keeps the job table the whole audit surface and makes
/// read-only-ness structural rather than promised.
const OPERATOR_RETRIEVE_INSTRUCTIONS: &str = "\
You are the Operator for the Overview. Someone has asked a question about the work that has happened in their coding sessions, and your job right now is ONLY to decide what to look up.

You cannot run commands or read files. You name verbs; the system runs them for you, read-only, and hands you the results. Choose the verbs that will actually answer the question.

The material below opens with a NOW: line — the current time, first as epoch milliseconds and then as a date and a clock. Verb time arguments are epoch milliseconds — compute them from NOW. \"Yesterday\" is NOW minus 86400000; \"this morning\" is a since_ms a few hours back. Never guess a timestamp; there is one on the page.

After it comes a SESSIONS (newest first): roster — the sessions the questions are usually about, with their callsigns, full ids, states, project dirs, and what each one is. When the question names a session by its project, its callsign, or what it was about, take the id from the roster and pass it straight to a verb: do not spend a verb discovering an id that is already in front of you. Use sessions.list only when you need sessions the roster does not carry — older ones, or a specific time range.

When the asker points at a file, a FILES NAMED BY THE QUESTION (verified to exist): section appears below the question, listing each path with its line count and, for the first two, an outline already run for you. Those paths are checked against the tree — the file is there, spelled exactly that way. Never spend a verb finding a file that is already on that list, and never doubt it exists. The outline is your map: take the line number nearest what was asked and go straight to repo.read around it.

Available verbs and their arguments:

- overview.search — query (full-text; supports AND/OR/quoted phrases), and optionally author, session_id, since_ms, until_ms. Finds posts in the channel's whole history.
- overview.window — post_id, n. The posts either side of a hit, to read the narrative around it.
- facts.search — query (full-text), and optionally kind, session_id, since_ms, until_ms. The fact base: prompts, session lifecycle, shell commands, test runs, commits. Kinds are prompt, session.spawned, session.resumed, session.closed, session.errored, session.reset, session.renamed, session.compacted, commit, shell, test_run.
- facts.list — all optional: kind, session_id, since_ms, until_ms. The same fact base, browsed by time instead of searched: the newest 30 matching facts, newest first.
- facts.window — fact_id, n. What else was happening around a fact.
- shell.history — optionally session_id, query (substring of the command), since_ms, until_ms. Verbatim command history from the session card's shell route, with an excerpt of each command's output.
- sessions.list — optionally since_ms, until_ms, active. Sessions with their titles, callsigns, synopses, and times — the roster below, gone deeper and further back.
- session.prompts — session_id, optionally query. What the person actually asked in that session.
- changes.for_session — session_id. Files that session touched, with the operation and how it was proven.
- changes.for_path — pattern (SQL LIKE, e.g. \"%.css\"), optionally since_ms, until_ms. Which sessions touched matching files, and when.
- git.log — optionally grep, pickaxe (content search), path, since, until, n, session_id. Commits.
- git.show — sha, optionally path, session_id. One commit's message and diff.
- repo.grep — pattern, optionally path_scope, session_id. The current state of the tree.
- repo.ls — pattern (a name fragment, a basename, or a git glob), optionally session_id. Real paths matching that name. Use it when you are unsure a file is spelled the way you think it is.
- repo.read — path, optionally start and end, or around_line with context, plus session_id. A file's actual lines, numbered. This is how you find out what a file SAYS.
- repo.outline — path, optionally session_id. A file's structural lines with their line numbers: headings, labelled decisions, declarations. Ask this first when the question is WHERE in a document something is, then read the line it points at.

Strategy that works: the channel's prose is good at locating WHEN something happened and WHICH session did it; the ledgers and git are what CONFIRM the specific fact. So narrow with overview.search, facts.list, or changes.for_path, then confirm. Never rely on a post's wording as the final answer when a ledger can settle it.

Confirm with the cheapest source that actually settles it. A fact result carries a detail object — a commit's files and message line, a test run's totals, a command's exit code — and those are exact, so a question about WHICH FILES a commit touched is already answered and needs no second lookup. git.show is the confirming source for what detail does not carry: the diff itself, and the body of a commit message below its first line. repo.grep answers what the tree says NOW, which is a different question from what any commit did.

The facts are ground truth for what was asked, what ran, and what happened: prompts in full, every shell command, test-run verdicts and totals, commits, and session lifecycle. Reach for the fact verbs when the question is about any of those — they settle them directly, without going through prose. shell.history is the verbatim command history when the question is which command ran rather than what a fact says about it.

facts.search answers \"find facts about X\" (best matches first); facts.list answers \"what happened\" (newest first). Reach for facts.list when the question is a time or a session, not a topic. Aim it: with no arguments it returns the newest 30 facts of every kind, which is mostly shell commands — pass a kind, a session_id, or a since_ms/until_ms bracket unless you really do want the last thirty things that happened.

A search query is AND-ed term by term: \"tooltip colors\" finds only records that contain BOTH words, and a phrase that reads naturally to a person often matches nothing at all. Search with ONE distinctive word and let the results narrow you. When the question names a kind of thing — \"which commit\", \"what did we run\", \"which test failed\" — pass the matching kind, or the page goes to whichever kind happened to say that word the loudest.

Names are findable by their parts: tooltip finds TugTooltip, sync finds useSyncExternalStore, 0365 finds at0365-overview-card.test.ts. Search the plain word rather than the spelling you would type in code.

A path argument is a real path. path and path_scope take a repo-relative path or a git glob — tuglaws/design-decisions.md, docs/, *.css — and NEVER a SQL LIKE pattern. changes.for_path is the only verb that speaks LIKE, and its % grammar must not travel: a path_scope of \"%design-decisions.md\" matches no file at all, and asking for both verbs in one round is exactly how that mistake gets made. If you are unsure how a file is spelled, spend one repo.ls on it.

Grep locates; read answers. repo.grep tells you WHERE a word is, in lines clipped to 240 characters — it cannot tell you what a passage says. When the question is what a file contains, or where inside it something lives, ask repo.outline for its structure and repo.read for the lines themselves. A repo.grep hit's line number goes straight into repo.read's around_line, so locate-then-read is one round, not two.

An outline gives boundaries, not content: it tells you a decision starts at line 267 and the next one at line 333, never what sits between them. So when the question is where inside a named file something is, ask for repo.outline AND a repo.grep for the question's most distinctive word IN THE SAME ROUND — the grep's line numbers land inside the outline's spans, and the two together answer without spending a second round on it.

A term the asker coined rarely appears verbatim in any file: \"the Z-zone drawing\" names a diagram whose own labels are Z0, Z1, Z2. grep for the piece most likely to be IN the text — zone, not Z-zone. A zero-match repo.grep retries itself case-insensitively and then by the pattern's pieces, and its note says when a rung fired — so read pattern_used before treating the rows as literal matches.

\"The recent commit about X\" is git.log with grep set to X. With no grep, since, or path, git.log returns only the last 20 commits — anything older is simply not in what comes back, so a question about work from more than a day or two ago needs one of those arguments to reach it at all.

Fact text looks like this — compose your queries against these words:

$ just app-test at0365-overview-card.test.ts → ok
tests: cargo nextest — passed (1614 passed, 0 failed)
commit 3f16971b \"tugways(transcript-copy): route native ⌘C through onCopy substitution\" — 4 file(s)

Ask for at most 6 verbs. Prefer two or three well-chosen ones. If the question needs a fact you can only get after seeing these results, you will get one more chance to ask later — do not try to cover every branch now.

Answer with JSON and nothing else — no prose before it, no code fence around it:

{\"verbs\": [{\"verb\": \"changes.for_path\", \"args\": {\"pattern\": \"%.css\", \"since_ms\": 1234567890000}}]}

Answer only from the material below.";

/// The answering half.
///
/// The two-round cap lives in Rust, but the model is told about it, because a
/// model that knows this is its last chance answers with what it has instead
/// of asking for a lookup it will never receive.
///
/// Prose hygiene is stated because the observed failures were both
/// serialization artifacts rather than judgment: answers said "at
/// 1786572090962" and spelled full UUIDs mid-sentence, because that is how the
/// verb results carry a time and a session. The results are machine values and
/// the answer is prose, so the conversion is the model's to make. Display-side
/// session annotation is a backstop for the ids that slip through, not the fix.
const OPERATOR_ANSWER_INSTRUCTIONS: &str = "\
You are the Operator for the Overview. Someone asked a question about the work in their coding sessions, verbs were run on your behalf, and their results are below. Answer the question.

Answer like a colleague who just looked it up: lead with the answer, then the evidence for it. Be specific — name the file, the commit, the session, the date. If the results settle the question, say so plainly. If they only narrow it, say what you found and what you could not confirm; do not present a guess as a fact, and never invent a path, sha, or date that is not in the results.

The channel's own posts are prose written by the Observer and are good for locating when something happened and which session did it. The ledger and git results are ground truth. When they disagree, trust the ledgers.

Wrap exact names in backticks — paths, commit shas, symbols, commands. The answer is rendered as markdown, so `tugdeck/src/main.tsx` reads as the name it is and becomes clickable by being written that way. Backtick every one of them, not the first: a path in backticks and the same path bare are one reference wearing two faces, and the reader has to work out that the difference means nothing.

The material below opens with a NOW: line — the current time, first as epoch milliseconds and then as a date and a clock. Compute reader times from the NOW line: it is what makes \"yesterday\" and \"this morning\" mean anything, and what an at_ms in the results converts against. After it comes a SESSIONS (newest first): roster — the sessions the question is likely about, with their callsigns and titles. Name a session in prose by its callsign or its title, which the roster gives you even when no verb returned that session; the id belongs in the refs.

The results are machine values; your answer is prose. Convert as you write. Express a time as a date and a clock a person reads — \"yesterday at 4:12pm\", \"on Aug 9\" — and NEVER as raw epoch milliseconds; a number like 1786572090962 says nothing to the reader it is shown to. Name a session by its project and callsign or by its title, never by a bare UUID in the middle of a sentence: the id belongs in the refs, where it is a link, not in the prose, where it is 36 characters of noise.

A fact result may carry a detail object beside its one-line text: a commit's files and message, a test run's totals, a command's exit code, a prompt's words. Its fields are exact — cite files, totals, and shas from it rather than reaching for another lookup to confirm what it already says.

Spell a commit sha exactly as the result gives it, in backticks, and let the app do the naming. Every sha that checks out against the repository is DISPLAYED as commit:<8ch> — the word supplied, the hash trimmed to eight characters — however you spelled it; and if your own word commit already sits right before the sha, the app shows the hash alone rather than doubling the word, which costs the reader the standard form, so write the bare sha and let the app name it. So write the sentence for meaning, not for the hash's looks: never trim, pad, or reconstruct a sha, because the exact characters are what the app verifies and links, and a sha it cannot verify stays plain text exactly as you wrote it. The refs still carry whatever the result spelled, exactly.

REFS are the clickable provenance on your answer. Include one for each file, commit, plan, brief, or session the answer genuinely rests on. Every target MUST be copied EXACTLY from the results — anything you reconstruct or abbreviate cannot be linked and will be discarded. Ref kinds are: session, file, commit, plan, brief.

Before you write that something could not be looked up, read this list again — it is every verb you may ask for: overview.search, overview.window, facts.search, facts.list, facts.window, shell.history, sessions.list, session.prompts, changes.for_session, changes.for_path, git.log, git.show, repo.grep, repo.ls, repo.read, repo.outline. git.log takes a grep argument, so \"which commit was about X\" is always reachable. If one of them could have answered it, ask for that verb rather than describing the gap — and if this is your last round, name the lookup plainly as the follow-up the reader could ask for, instead of leaving them thinking the system has no way to reach it.

NEVER write that something is absent from a file unless a scan of that exact file came back ok with zero rows. A verb that errored did not look, and a verb whose note says its path was repaired looked somewhere else — neither is evidence of absence, and saying \"the term does not appear in that document\" on the strength of one is the worst answer this channel can give, because it is confident and wrong. When a lookup failed, say the lookup failed.

When a result carries a note, a path_used, or a path_scope_used that differs from what was asked for, say so in the answer. The system repairs a misspelled or malformed path rather than refusing it, so the file that was actually read may not be the file the question named — presenting a repaired match as an exact one hides the one fact the reader needs to judge it.

If the results are not enough and one more lookup would settle it, you may ask for more verbs instead of answering — but ONLY ONCE. If you have already been given a second round of results, you must answer now with what you have, saying what remains unconfirmed.

Answer with JSON and nothing else — no prose before it, no code fence around it.

To answer:
{\"answer\": {\"body\": \"...\", \"refs\": [{\"kind\": \"file\", \"target\": \"tugdeck/styles/themes/brio.css\"}]}}

To ask for one more round of lookups:
{\"verbs\": [{\"verb\": \"git.show\", \"args\": {\"sha\": \"a1b2c3d4\"}}]}

Answer only from the material below.";

#[cfg(test)]
mod tests {
    use super::*;

    fn job(name: &str) -> &'static JobSpec {
        OVERVIEW_AGENT_JOBS
            .iter()
            .find(|j| j.name == name)
            .unwrap_or_else(|| panic!("{name} missing from the overview job table"))
    }

    /// The contracts Rust enforces downstream have to be the ones the model
    /// was actually told about. Each assertion here pins a string that some
    /// other code path depends on the model having read.
    #[test]
    fn the_job_table_carries_every_contract_the_gates_depend_on() {
        assert_eq!(OVERVIEW_AGENT_JOBS.len(), 3);

        // Silence is a first-class output, and the parser accepts exactly this
        // shape — a model that was never told so would answer prose.
        let observer = job("observer-post").instructions;
        assert!(observer.contains(r#"{"post": null}"#));
        assert!(observer.contains(r#""refs""#));
        // …but bounded to the two cases it is for. An open-ended "posting
        // nothing is often right" let the model treat a finished turn whose
        // subject was not code as unremarkable, which is the opposite of the
        // channel's job. Both halves are pinned: the two uses, and the
        // requirement to post outside them.
        assert!(observer.contains("Silence is a real answer, and it has exactly two uses"));
        assert!(observer.contains("Outside those two cases, POST."));
        assert!(observer.contains("ALWAYS summarize what the turn did"));
        assert!(
            !observer.contains("often the right one"),
            "the open-ended silence license is what made a finished turn go unreported",
        );
        // Voice: one register for every subject. The rule is pinned, and so is
        // the absence of the framing that provoked it — telling the Observer to
        // post "even when it isn't code" is what produced a post opening
        // "Answered a physics question, not code:". The prompt must not name
        // code as the baseline the work is measured against.
        assert!(observer.contains("Report the work; never your view of it"));
        assert!(observer.contains("never define it by what it was not"));
        // Length is a budget, not an adjective. "A few sentences at most" drew
        // 100-plus-word posts that reproduced the answer the session had
        // already given; a countable limit and the summary-not-content rule
        // are what actually bind.
        assert!(observer.contains("200 characters of prose at the outside"));
        assert!(observer.contains("The post is the summary, never the content"));
        assert!(
            !observer.contains("nothing to do with their code"),
            "naming code as the baseline is what the Observer then narrated",
        );
        // The budget's size was never what truncated posts mid-clause —
        // nothing asked for sentences that FIT it. `clamp_post_body` is the
        // backstop for a model that ignores this, not a substitute for it.
        assert!(observer.contains("Every sentence you write must be COMPLETE"));
        assert!(observer.contains("end the sentence sooner"));
        // Backticks are asked for, not hoped for: the body renders as
        // markdown, and a backticked name is a code span the annotator
        // resolves — clickable BECAUSE it was written that way. Bounded
        // deliberately; the rest of markdown would only decorate a notice in
        // a narrow rail.
        assert!(observer.contains("Wrap exact names in backticks"));
        assert!(observer.contains("no lists, no headings, no emphasis"));
        // The facts section: the header string the composer prints has to be the
        // string the model was told about, or the paragraph explains a section
        // it never sees under that name. The dedup clause is pinned too — the
        // section carries facts that are settled rather than new, so without it
        // a commit already posted about would be announced on every wake for as
        // long as it stayed in the window.
        assert!(observer.contains(crate::feeds::observer_wake::FACTS_SECTION_HEADER));
        assert!(observer.contains("It is ground truth"));
        assert!(observer.contains("is not news twice"));
        // Ref targets are validated verbatim against the buffered context, so
        // the instruction to copy exactly is what keeps the drop rate down.
        // The path clause is the specific fix for the one drop the offline
        // sweep actually produced: a repo-relative path expanded to an
        // absolute one, which no window contains and no chip can link.
        assert!(observer.contains("EXACTLY"));
        assert!(observer.contains("Spell a path the way the activity spells it"));
        // Every wake reason the bridge can send is explained.
        for reason in ["turn-end", "sitrep-timer", "session-end", "token-threshold"] {
            assert!(
                observer.contains(reason),
                "wake reason {reason} unexplained"
            );
        }
        // The rubric, which is the editorial contract.
        for beat in [
            "investigation results",
            "/devise",
            "/implement",
            "brief finished being written",
            "commit landed",
            "sitrep",
        ] {
            assert!(observer.contains(beat), "rubric lost {beat:?}");
        }

        // Retrieval names every verb the executor implements; a verb the model
        // never hears about is a verb that is never called.
        let retrieve = job("operator-retrieve").instructions;
        for verb in [
            "overview.search",
            "overview.window",
            "sessions.list",
            "session.prompts",
            "changes.for_session",
            "changes.for_path",
            "git.log",
            "git.show",
            "repo.grep",
        ] {
            assert!(retrieve.contains(verb), "verb {verb} missing from retrieve");
        }
        assert!(retrieve.contains(r#""verbs""#));
        assert!(retrieve.contains("at most 6 verbs"));
        // The clock. The composer prints a section under this label, and every
        // time argument the model writes is computed from it — a model never
        // told the line is there composes a since_ms out of nothing.
        assert!(retrieve.contains(crate::feeds::operator::NOW_HEADER));
        assert!(retrieve.contains("Verb time arguments are epoch milliseconds"));
        // The roster, under the same header the composer prints. Its whole
        // point is the discovery round it saves, which is what the second
        // clause is for — round two is forced, so a round spent finding an id
        // is a round the real question does not get.
        assert!(retrieve.contains(crate::feeds::operator::SESSIONS_HEADER));
        assert!(retrieve.contains("do not spend a verb discovering an id"));
        // The asker's own pointing gesture, under the header the composer
        // prints. A section the model was never told about is one it has to
        // guess the meaning of, and the guess that costs the most is doubting
        // the file exists — the whole point of verifying it in Rust was to
        // hand the model a fact rather than a hint.
        assert!(retrieve.contains(crate::feeds::operator::QUESTION_FILES_HEADER));
        assert!(
            retrieve.contains("Never spend a verb finding a file that is already on that list")
        );
        // Two orderings are two tools, and the sentence that divides them is
        // what stops the model reaching for a relevance search when the
        // question is a time. Its aiming clause is pinned too: teaching WHEN
        // to reach for facts.list without teaching HOW to aim it buys a
        // firehose of shell rows in place of an answer.
        assert!(retrieve.contains(
            "facts.search answers \"find facts about X\" (best matches first); \
             facts.list answers \"what happened\" (newest first)"
        ));
        assert!(retrieve.contains("pass a kind, a session_id, or a since_ms/until_ms bracket"));
        // The example renderings are quoted from `render_text`'s real output,
        // because FTS matches against exactly those words — a query composed
        // against an imagined format finds nothing.
        // `detail` changed which source is cheapest, so the confirm-with steer
        // had to change with it: a file list no longer needs a git.show round,
        // and git.show keeps the jobs detail cannot do.
        assert!(retrieve.contains("Confirm with the cheapest source that actually settles it"));
        assert!(
            retrieve.contains("git.show is the confirming source for what detail does not carry")
        );
        assert!(retrieve.contains("Fact text looks like this"));
        assert!(retrieve.contains("tests: cargo nextest — passed"));
        assert!(retrieve.contains("$ just app-test"));
        // What the index actually does, told plainly. The recovery ladder in
        // Rust relaxes an AND query that matched nothing, but recovery is the
        // backstop and these three sentences are the aim: terms are AND-ed, so
        // a natural phrase misses; a kind is what keeps the loudest kind from
        // spending the page; and a name is reachable by its parts because the
        // index carries their sub-words.
        assert!(retrieve.contains("A search query is AND-ed term by term"));
        assert!(retrieve.contains("Search with ONE distinctive word"));
        assert!(retrieve.contains("pass the matching kind"));
        assert!(retrieve.contains("Names are findable by their parts"));
        assert!(retrieve.contains("tooltip finds TugTooltip"));
        // The observed miss: repo.grep for "Z-zone" against a document whose
        // own labels are Z0–Z5 returned nothing, and the question died on it.
        // Two halves: aim the grep at a word the text would contain, and read
        // pattern_used/note when the Rust ladder recovered the rows itself.
        assert!(retrieve.contains("A term the asker coined"));
        assert!(retrieve.contains("grep for the piece most likely to be IN the text"));
        assert!(retrieve.contains("pattern_used"));
        // The wish the 2026-08-15 transcript ended on — "I'd need a search
        // scoped to tooltip in the commit history" — named a verb argument the
        // model was already holding. The horizon clause is the other half:
        // without grep/since/path, git.log cannot see past 20 commits, so a
        // model that reaches for it bare concludes the commit does not exist.
        // Incident B, 2026-08-16: the model wrote a correct pattern (`zone`)
        // with a path_scope of `%design-decisions.md` — `changes.for_path`'s
        // SQL LIKE grammar, carried into a git pathspec in the same round. The
        // scope matched no file, so nothing was searched, and the answering
        // model read `rows=0` as proof of absence. Rust now refuses an
        // unmatched scope outright; this is the half that stops the model
        // writing one in the first place.
        assert!(retrieve.contains("A path argument is a real path"));
        assert!(retrieve.contains("NEVER a SQL LIKE pattern"));
        assert!(retrieve.contains("changes.for_path is the only verb that speaks LIKE"));
        // The structural gap the file verbs close: thirteen verbs could locate
        // a line and none could read one, so a question about what a file says
        // had to be answered from 240-character clippings.
        assert!(retrieve.contains("Grep locates; read answers"));
        assert!(retrieve.contains("around_line"));
        // Seen in the step-5 replay: given only an outline, the model named
        // D97's span and then hedged, because an outline reports where a
        // decision begins and never what is inside it. Pairing it with a grep
        // in the same round is what turns two cheap verbs into one exact
        // answer, and costs no extra round.
        assert!(retrieve.contains("An outline gives boundaries, not content"));
        assert!(retrieve.contains("IN THE SAME ROUND"));
        assert!(retrieve.contains("is git.log with grep set to X"));
        assert!(retrieve.contains("git.log returns only the last 20 commits"));

        // The answer job must know both of its output shapes and that its
        // second round is final.
        let answer = job("operator-answer").instructions;
        assert!(answer.contains(r#""answer""#));
        assert!(answer.contains(r#""verbs""#));
        assert!(answer.contains("ONLY ONCE"));
        assert!(answer.contains("EXACTLY"));
        // Prose hygiene: both observed leaks are serialization artifacts —
        // the verb results carry a time as epoch ms and a session as a UUID,
        // and answers repeated them into sentences a person has to read.
        assert!(answer.contains("NEVER as raw epoch milliseconds"));
        assert!(answer.contains("never by a bare UUID in the middle of a sentence"));
        // …which is a rule with no *today* to convert against until the clock
        // rides the turn, so the answer job is told about the line too.
        assert!(answer.contains(crate::feeds::operator::NOW_HEADER));
        assert!(answer.contains("Compute reader times from the NOW line"));
        // The voice rule asks for a session's callsign; the roster is what
        // makes that satisfiable when no sessions.list verb ran.
        assert!(answer.contains(crate::feeds::operator::SESSIONS_HEADER));
        // Depth is only worth serving if the answer knows it may cite from it.
        // The refs that invites validate by construction: `validate_refs`
        // checks against the rendered results, and `detail` is rendered.
        assert!(answer.contains("detail object"));
        assert!(answer.contains("Its fields are exact"));
        // The answer turn's input carries results, never the verb list — so
        // "read the verb list again" is only satisfiable because the list is
        // spelled here. Pinned against the executor's own names for the same
        // reason the retrieve list is: a verb the model is told about must
        // exist, and one it is never told about is one it cannot ask for.
        assert!(answer.contains("Before you write that something could not be looked up"));
        for verb in crate::feeds::operator::VERB_NAMES {
            assert!(answer.contains(verb), "verb {verb} missing from answer");
        }
        assert!(answer.contains("git.log takes a grep argument"));
        // The absence rule. `rows=0` only became evidence of anything once an
        // unmatched scope started erroring instead of returning empty; this is
        // the sentence that tells the model what its one meaning is, and it is
        // the direct counter to the false-absence answer of 2026-08-16.
        assert!(answer.contains("NEVER write that something is absent"));
        assert!(answer.contains("ok with zero rows"));
        assert!(answer.contains("did not look"));
        // A repaired path means the file read may not be the file named, which
        // is a fact only the answer can surface — the reader cannot see the
        // verb results.
        assert!(answer.contains("path_used"));
        assert!(answer.contains("path_scope_used"));
    }

    /// Every job answers with JSON that a strict parser reads, so an
    /// instruction that allowed a code fence or a preamble would produce a
    /// silent no-post.
    #[test]
    fn every_job_demands_bare_json() {
        for spec in OVERVIEW_AGENT_JOBS {
            assert!(
                spec.instructions.contains("no code fence around it"),
                "{} may answer with a fenced block",
                spec.name,
            );
            assert!(
                spec.instructions
                    .contains("Answer only from the material below"),
                "{} is not told to answer only from its input",
                spec.name,
            );
        }
    }

    /// Nothing user-blocking waits on a post, but a person does wait on an
    /// answer — and the retrieval leg is a short structured reply, so it gets
    /// the tightest ceiling of the three.
    #[test]
    fn job_ceilings_match_what_each_one_keeps_someone_waiting_for() {
        assert!(job("operator-retrieve").timeout < job("operator-answer").timeout);
        assert_eq!(job("observer-post").timeout, Duration::from_secs(120));
        for spec in OVERVIEW_AGENT_JOBS {
            let slow = spec.slow.expect("every job marks drift");
            assert!(
                slow < spec.timeout,
                "{} slow mark is unreachable",
                spec.name
            );
        }
    }

    /// The cadence default is the one number the whole channel's feel rests
    /// on, and it was set by reading three offline replays rather than by
    /// argument. A silent drift back up would change how the app feels with
    /// nothing to point at.
    #[test]
    fn cadence_defaults_are_the_tuned_starting_values() {
        assert_eq!(DEFAULT_SITREP_SECS, 90);
        assert_eq!(DEFAULT_LAST_K_POSTS, 5);
        assert_eq!(DEFAULT_TOKEN_WAKE_TOKENS, 0, "threshold wake is opt-in");
        assert_eq!(
            DEFAULT_MAX_WORKERS, 3,
            "one lane, three jobs: a question must not queue behind a digest",
        );
    }
}
