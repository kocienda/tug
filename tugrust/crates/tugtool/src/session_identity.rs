//! The calling session's identity — **the one place `$TUG_SESSION_ID` is
//! read**, and the one place a posted id becomes a session the machine will
//! answer for ([P01]).
//!
//! `TUG_SESSION_ID` is frozen in a process's environment at spawn, and the
//! Wheel rotates a card's session *on purpose* — above
//! `implement_compact_tokens`, on a threshold any long implement stage
//! crosses. So the id a short-lived `tugtool` process was born with routinely
//! names a segment that closed and was demoted two rotations ago. A verb that
//! uses it raw writes onto a corpse and reports success: a truthful sentence
//! about the wrong session, which is exactly how an arc came to be stranded
//! while every gesture said it had worked
//! (`notes/wheel-rotation-strands-the-arc.md`).
//!
//! The answer is not "expand it at each door" — that was tried, once per
//! caller, and each fix left the next caller exposed. The answer is that the
//! raw id is **unusable**: every verb calls [`resolve`] (or [`resolve_soft`]),
//! and `tugcore`'s `no_raw_session_id_reads` source scan refuses a second
//! reader of the variable anywhere in the workspace. The chokepoint is
//! structural, so the next verb cannot forget.
//!
//! The expansion itself belongs to the instance that owns the line —
//! `sessions.db` is per-instance — so this asks it, over the same
//! try-each-instance POST the binding verbs use, at `POST /api/session`
//! `{op: "resolve"}`.

use crate::dash::post_instance_api;

/// A resolved calling session: what was posted, what it resolved to, and
/// enough of the ledger's answer to write a sentence about either.
#[derive(Debug, Clone)]
pub(crate) struct Resolved {
    /// The id the process was born with (or `--session`'s argument).
    pub posted: String,
    /// The live segment of the posted id's line — the session every verb
    /// addresses. Equal to `posted` in the ordinary un-rotated case, and on
    /// the soft fallback below.
    pub session_id: String,
    /// The resolved segment's ledger `state`, or `None` when no instance
    /// answered.
    pub state: Option<String>,
    /// The line the posted id belongs to, when an instance placed it.
    pub line_id: Option<String>,
    /// The checkout this session works, as the ledger row spells it.
    ///
    /// `None` from an instance that predates the field — and from the soft
    /// fallback, where nobody answered at all. A caller uses it to tell "this
    /// session could have done that and did not" from "this session was never
    /// entitled to", and must treat `None` as "cannot tell".
    pub project_dir: Option<String>,
    /// Every segment id the line has worn — what a session-keyed *reader*
    /// expands over. Empty when nothing answered.
    pub segments: Vec<String>,
    /// Whether the resolution actually moved: the posted id named a segment
    /// that is no longer the seated one.
    pub rotated: bool,
    /// Whether an instance answered at all. `false` is the soft fallback:
    /// the posted id, unexpanded, because there was nobody to ask.
    pub resolved: bool,
}

impl Resolved {
    /// The posted id, unexpanded — the answer when no instance could be
    /// asked. Never reached by a verb that needs an instance anyway.
    fn unresolved(posted: String) -> Self {
        Resolved {
            session_id: posted.clone(),
            posted,
            state: None,
            line_id: None,
            project_dir: None,
            segments: Vec::new(),
            rotated: false,
            resolved: false,
        }
    }

    /// Every key a session-addressed row may sit under, most-current first:
    /// the live segment, then the rest of the line, then the posted id. A
    /// reader probes these in order so a row written under an earlier segment
    /// still surfaces after a rotation.
    pub(crate) fn keys(&self) -> Vec<String> {
        let mut keys = vec![self.session_id.clone()];
        for id in self.segments.iter().chain(std::iter::once(&self.posted)) {
            if !keys.contains(id) {
                keys.push(id.clone());
            }
        }
        keys
    }
}

/// The id this process was born with — **the only read of `TUG_SESSION_ID`
/// in the workspace outside the spawn-time exporters.**
///
/// Private on purpose: a caller that wants the id wants the *resolved* one,
/// and the two functions below are the only ways to reach it.
fn posted_session_id() -> Option<String> {
    std::env::var("TUG_SESSION_ID")
        .ok()
        .filter(|s| !s.is_empty())
}

/// Whether this process was born with a calling session at all.
///
/// The one question about the raw id that is not about its *value*, and so the
/// one a caller may ask without resolving. A verb whose claim is best-effort
/// asks it to tell "there is nobody to claim for" — a headless run, a fixture,
/// a plain terminal — apart from "somebody was asked and said no". The id
/// itself does not leave this module.
pub(crate) fn have_calling_session() -> bool {
    posted_session_id().is_some()
}

/// The calling session, resolved to its line's live segment, or the
/// actionable refusal naming what to do.
///
/// `subject` names what wanted the session, so the refusal says why it is
/// asking rather than reporting whatever the first caller happened to be.
/// `session` is `--session`'s argument, which overrides the environment and
/// is resolved on exactly the same terms — an id typed by hand goes stale the
/// same way one inherited from a spawn does.
pub(crate) fn resolve(subject: &str, session: Option<&str>) -> Result<Resolved, String> {
    let posted = session
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .or_else(posted_session_id)
        .ok_or_else(|| {
            format!(
                "no session — {subject} names the calling session, so run this from a Session \
                 card, pass --session <id>, or set TUG_SESSION_ID"
            )
        })?;
    ask_instance(&posted).map_err(|message| {
        // `unknown_session` is the walk's "not mine" answer; when *every*
        // instance says it, the id belongs to no machine that is running.
        if message == "unknown_session" {
            // The trailing token is a **contract**, not leakage. This refusal
            // has one legitimately transient cause — the ledger row a card's
            // spawn writes has not landed yet — and a caller that must sit
            // through that window needs to tell it from a permanent refusal.
            // Before this module the walk's raw `unknown_session` reached
            // stderr and callers branched on it; replacing it with prose alone
            // broke the app-test fixture's retry loop
            // (`tests/app-test/dash-fixture.ts`'s `bindDash`) silently, and the
            // breakage surfaced three workstreams downstream. So the token
            // stays, and the CLI test below fails in `cargo nextest` the next
            // time somebody rewrites the sentence.
            format!(
                "no running Tug instance knows session {posted} — {subject} needs the card that \
                 session works, and nothing here is holding it (unknown_session)"
            )
        } else {
            format!("{subject} could not resolve session {posted}: {message}")
        }
    })
}

/// [`resolve`], but a machine that cannot be asked is not an error.
///
/// For the verbs that still mean something with no instance running — a
/// `draft` under `TUG_CHANGES_DB`, a `changes` read straight off the ledger.
/// They get the posted id back with `resolved: false`, which is the same
/// answer they had before this module existed, reached deliberately instead
/// of by omission.
pub(crate) fn resolve_soft(session: Option<&str>) -> Option<Resolved> {
    let posted = session
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .or_else(posted_session_id)?;
    Some(ask_instance(&posted).unwrap_or_else(|_| Resolved::unresolved(posted)))
}

/// Ask the owning instance a session-addressed question **whose op resolves at
/// its own door**, with the posted id filled in from this process's identity.
///
/// The chokepoint's one narrow opening, and what makes it safe: no caller ever
/// receives the raw id, and every op reached this way expands it server-side
/// exactly as `/api/dash` does. What it buys is a single round trip instead of
/// a resolve followed by the real question — which matters on the hot path,
/// where the PreToolUse gate asks on every write-shaped tool call a course
/// stage makes.
///
/// The outer `None` is "this process has no calling session at all" — a plain
/// terminal, a fixture, a foreign project — which is not a failure and must
/// never read as one. The inner `Err` is an instance that answered and refused,
/// including `unknown op` from one older than the op; every caller of this is
/// advisory ([P01]'s skew rule, Part IV item 4) and must degrade rather than
/// refuse on it.
pub(crate) fn ask_about_calling_session(
    op: &str,
    subject: &str,
    fields: serde_json::Value,
) -> Option<Result<serde_json::Value, String>> {
    let posted = posted_session_id()?;
    let mut body = serde_json::json!({ "op": op, "tug_session_id": posted });
    if let (Some(target), Some(extra)) = (body.as_object_mut(), fields.as_object()) {
        for (key, value) in extra {
            target.insert(key.clone(), value.clone());
        }
    }
    Some(post_instance_api("/api/session", subject, body))
}
/// Ask the instance that owns the line. Walks every live instance, exactly as
/// a binding write does: `sessions.db` is per-instance, so the first machine
/// to answer is not always the right one.
fn ask_instance(posted: &str) -> Result<Resolved, String> {
    let response = post_instance_api(
        "/api/session",
        "resolving the calling session",
        serde_json::json!({ "op": "resolve", "tug_session_id": posted }),
    );
    let response = match response {
        Ok(response) => response,
        // An instance older than the chokepoint answers `unknown op
        // 'resolve'`. Refusing there would break every session-addressed verb
        // the moment a new `tugtool` met a tugcast that had not restarted —
        // and it is not necessary: `/api/dash` resolves at its own door, so a
        // bind still lands on the live segment. What is lost is this side's
        // ability to *name* the resolution, which is a receipt, not a write.
        Err(message) if message.contains("unknown op") => {
            return Ok(Resolved::unresolved(posted.to_string()));
        }
        Err(message) => return Err(message),
    };
    let str_field = |key: &str| {
        response
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    let session_id = str_field("session_id").unwrap_or_else(|| posted.to_string());
    Ok(Resolved {
        rotated: session_id != posted,
        posted: posted.to_string(),
        session_id,
        state: str_field("state"),
        line_id: str_field("line_id"),
        project_dir: str_field("project_dir"),
        segments: response
            .get("segments")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        resolved: true,
    })
}
