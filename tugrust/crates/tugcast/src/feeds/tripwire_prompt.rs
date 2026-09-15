//! The trip prompt — everything a fired tripwire's session is told, and nothing
//! it would have to reconstruct (Spec S02).
//!
//! **Assembled by the engine, on the engine's own task.** The fact was recorded
//! on a path that must not wait for anybody to read it, so the recorder sends a
//! small row and this module does the work afterwards: the session's segments,
//! their transcript paths, the uncommitted diff beside the tree.
//!
//! **Paths rather than bytes, a stat rather than a diff.** The session reads
//! what it decides it needs; the prompt stays bounded whatever the checkout's
//! size. A transcript that cannot be read shrinks the prompt and is named in it
//! — never a silent gap, because a diagnosis working from half a history it
//! believes is whole is worse than one told which half it has.
//!
//! **Session ids rotate, so the transcripts have two sources.** The fact names
//! the session that recorded it; that session is expanded through its line to
//! every segment id it has ever worn, and the union is what gets transcript
//! paths. Reading only the id the fact carried would miss the earlier half of
//! any session that rotated mid-work.

use std::collections::BTreeSet;
use std::path::PathBuf;

use crate::session_ledger::{FactRow, SessionLedger};

/// One session segment, resolved as far as this instance's ledger can.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTranscript {
    pub session_id: String,
    /// The transcript on disk, or `None` when the ledger cannot name the
    /// session or the file is not there. Either way the entry survives — a
    /// session that cannot be read is a fact about the prompt.
    pub transcript: Option<PathBuf>,
}

/// What a trip knows, composed once and rendered into the prompts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TripPrompt {
    /// The fact the tripwire fired on, read back off the trip row (Spec S01).
    pub fact: FactRow,
    /// The checkout the fact was recorded in.
    pub repo_root: String,
    /// The tripwire's arc, whose worktree the trip stands in ([P02]).
    pub arc: String,
    /// Where that worktree is, so the session knows which directory it is in.
    pub tree: PathBuf,
    pub session: Vec<SessionTranscript>,
    /// The probe's exit and output tail, when the tripwire has one and it failed
    /// ([P10]). A green probe never reaches a prompt, because it settles the
    /// trip instead.
    pub probe: Option<ProbeReport>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeReport {
    pub command: String,
    pub exit: i64,
    pub tail: String,
}

/// The fact the trip fired on, read back off the row it was written onto
/// (Spec S01).
///
/// Off the row rather than out of memory, because the run composes its prompt
/// minutes later on another task: the live row is out of reach by then, and
/// after a restart this payload is the only record of the fact there is. A
/// payload no build can parse answers `None`, and the prompt says so rather
/// than taking the engine down over a row an older build wrote.
pub fn fact_from_evidence(payload: &str) -> Option<FactRow> {
    let value = serde_json::from_str::<serde_json::Value>(payload).ok()?;
    let row = value.get("fact")?;
    let text = |name: &str| row.get(name).and_then(|v| v.as_str()).map(str::to_owned);
    Some(FactRow {
        id: row
            .get("id")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        at_ms: row
            .get("at_ms")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        kind: text("kind").unwrap_or_default(),
        session_id: text("session_id"),
        subject: text("subject"),
        text: text("text").unwrap_or_default(),
        payload: row
            .get("payload")
            .map(|p| p.to_string())
            .unwrap_or_else(|| "{}".to_string()),
    })
}

/// Expand the fact's session to every id its line has worn, and resolve each to
/// a transcript.
///
/// Both sources are read because ids rotate: the fact names the session that
/// recorded it, and the ledger's line records name the segments that session
/// was before. A fact recorded by a rotated tip and nothing else would otherwise
/// hand the diagnosis the last few turns of the work and call it the history.
pub fn session_transcripts(
    ledger: &SessionLedger,
    session_ids: &[String],
) -> Vec<SessionTranscript> {
    session_segments(ledger, session_ids)
        .into_iter()
        .map(|session_id| SessionTranscript {
            transcript: transcript_path(ledger, &session_id),
            session_id,
        })
        .collect()
}

/// The named sessions, expanded through their lines to every id each has worn,
/// sorted and deduplicated.
///
/// Split out from [`session_transcripts`] because the expansion is not only the
/// prompt's business: the facts the predicate reads are attributed per session
/// id, so work evaluated against the tip id alone would miss everything an
/// earlier segment of the same session recorded — a tripwire that silently does
/// not fire, which is worse than one that fires on nothing.
pub fn session_segments(ledger: &SessionLedger, session_ids: &[String]) -> Vec<String> {
    let mut ids: BTreeSet<String> = BTreeSet::new();
    for id in session_ids {
        ids.insert(id.clone());
        if let Some(line_id) = ledger.line_of(id)
            && let Ok(Some(line)) = ledger.line_ownership(&line_id)
        {
            ids.extend(line.segment_ids);
        }
    }
    ids.into_iter().collect()
}

/// Where a session's transcript lives, or `None` when the ledger cannot name
/// the session or the file is not on disk.
fn transcript_path(ledger: &SessionLedger, session_id: &str) -> Option<PathBuf> {
    let row = ledger.get(session_id).ok().flatten()?;
    let (dir, _) =
        crate::session_ledger::claude_project_dir(ledger.claude_projects_root(), &row.project_dir);
    let path = dir.join(format!("{session_id}.jsonl"));
    path.exists().then_some(path)
}

impl TripPrompt {
    /// The prompt a fired tripwire's session is handed, in the section order
    /// Spec S02 fixes: brief, fact, tree, probe, session, contract.
    ///
    /// Everything but the closing contract is the same whatever the session
    /// is for, because it is the same trip being described. The contract is
    /// the caller's to supply, and this is the one place the order lives.
    pub fn prompt(&self, brief: &str, contract: &str) -> String {
        let mut out = String::new();
        out.push_str("BRIEF\n");
        out.push_str(brief.trim());
        out.push_str("\n\nFACT\n");
        out.push_str(&self.fact_section());
        out.push_str("\n\nTREE\n");
        out.push_str(&self.tree_section());
        if let Some(probe) = &self.probe {
            out.push_str("\n\nPROBE\n");
            out.push_str(&format!(
                "`{}` exited {}. Its output ends:\n{}",
                probe.command,
                probe.exit,
                probe.tail.trim()
            ));
        }
        out.push_str("\n\nSESSION\n");
        out.push_str(&self.session_section());
        out.push_str("\n\nCONTRACT\n");
        out.push_str(contract.trim());
        out
    }

    fn fact_section(&self) -> String {
        let session = match &self.fact.session_id {
            Some(id) => id.as_str(),
            None => "no session",
        };
        let mut out = format!(
            "A {} fact was recorded at {} by {}.\n{}",
            self.fact.kind,
            self.fact.at_ms,
            session,
            self.fact.text.trim()
        );
        if let Some(subject) = &self.fact.subject
            && !subject.is_empty()
        {
            out.push_str(&format!("\nSubject: {subject}"));
        }
        let payload = serde_json::from_str::<serde_json::Value>(&self.fact.payload)
            .ok()
            .and_then(|v| serde_json::to_string_pretty(&v).ok())
            .unwrap_or_else(|| self.fact.payload.clone());
        out.push_str(&format!("\n{payload}"));
        out
    }

    fn tree_section(&self) -> String {
        format!(
            "You are standing in the worktree of the arc `{arc}`, at `{path}`. It is this \
             tripwire's own checkout, replayed onto its base's HEAD for this trip — not the \
             user's working copy. Work only under that path, and give every command an \
             absolute path; a shell's working directory does not survive between commands.\n\
             `tugtool arc commit {arc} --message \"<subject>\"` is the only thing that commits \
             here, and joining the work back is the user's act, never yours.",
            arc = self.arc,
            path = self.tree.display(),
        )
    }

    fn session_section(&self) -> String {
        if self.session.is_empty() {
            return "No session: this trip was fired by hand.".to_string();
        }
        let mut out =
            String::from("These transcripts are the history behind the fact, and may be read:\n");
        for entry in &self.session {
            match &entry.transcript {
                Some(path) => out.push_str(&format!("{} — {}\n", entry.session_id, path.display())),
                None => out.push_str(&format!(
                    "{} — no transcript this instance can read\n",
                    entry.session_id
                )),
            }
        }
        out.trim_end().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trip row's evidence, in the Spec S01 shape: one fact, whole.
    fn payload() -> String {
        serde_json::json!({
            "fact": {
                "id": 1,
                "at_ms": 1_700_000_000_000i64,
                "kind": "edit_failed",
                "session_id": "sess-a",
                "subject": "a.rs",
                "text": "edit 0 went stale",
                "payload": {"class": "resolve"},
            },
        })
        .to_string()
    }

    fn trip_prompt(session: Vec<SessionTranscript>) -> TripPrompt {
        TripPrompt {
            fact: fact_from_evidence(&payload()).expect("the fixture parses"),
            repo_root: "/proj".to_string(),
            arc: "tripwire-ci".to_string(),
            tree: PathBuf::from("/arcs/tripwire-ci"),
            session,
            probe: None,
        }
    }

    /// The closing contract a test supplies, standing in for whatever phase's
    /// contract the engine passes.
    const CONTRACT: &str = "You are working on the arc `tripwire-ci-abcd1234`. \
                            Close your turn with one JSON object.";

    /// The fact reads back off the row it was written onto (Spec S01), and an
    /// unreadable payload is `None` rather than a panic: the row belongs to
    /// whatever build wrote it, and a newer shape must not take the engine down.
    #[test]
    fn the_fact_reads_back_off_the_row_it_was_written_onto() {
        let fact = fact_from_evidence(&payload()).expect("the fixture parses");
        assert_eq!(fact.kind, "edit_failed");
        assert_eq!(fact.text, "edit 0 went stale");
        assert_eq!(fact.session_id.as_deref(), Some("sess-a"));
        assert!(fact.payload.contains("\"class\":\"resolve\""), "{fact:?}");

        assert!(fact_from_evidence("not json").is_none());
        assert!(fact_from_evidence("{}").is_none());
    }

    /// The prompt's section order is the spec's, and a reader who saw none of
    /// the run can follow it top to bottom.
    #[test]
    fn the_prompt_carries_every_section_in_the_order_the_spec_fixes() {
        let p = trip_prompt(vec![SessionTranscript {
            session_id: "sess-a".to_string(),
            transcript: Some(PathBuf::from("/t/sess-a.jsonl")),
        }]);
        let prompt = p.prompt("diagnose the failure", CONTRACT);

        let order = ["BRIEF", "FACT", "TREE", "SESSION", "CONTRACT"];
        let mut at = 0;
        for section in order {
            let found = prompt[at..]
                .find(section)
                .unwrap_or_else(|| panic!("{section} is missing or out of order in:\n{prompt}"));
            at += found + section.len();
        }
        assert!(prompt.contains("edit 0 went stale"), "{prompt}");
        assert!(prompt.contains("/arcs/tripwire-ci"), "{prompt}");
        assert!(
            prompt.contains("tugtool arc commit tripwire-ci"),
            "the tree section says what committing here means: {prompt}"
        );
        assert!(prompt.contains("/t/sess-a.jsonl"), "{prompt}");
        assert!(
            prompt.contains("`tripwire-ci-abcd1234`"),
            "the caller's contract states the arc by name: {prompt}"
        );
        assert!(
            !prompt.contains("PROBE"),
            "no probe on this tripwire: {prompt}"
        );
    }

    /// A failed probe's tail rides in the prompt, not only in the trip row.
    #[test]
    fn a_failed_probe_is_a_section_of_its_own() {
        let mut p = trip_prompt(Vec::new());
        p.probe = Some(ProbeReport {
            command: "just ci".to_string(),
            exit: 3,
            tail: "error[E0425]: cannot find value".to_string(),
        });
        let prompt = p.prompt("diagnose the failure", CONTRACT);
        assert!(prompt.contains("`just ci` exited 3"), "{prompt}");
        assert!(prompt.contains("error[E0425]"), "{prompt}");
        let tree_at = prompt.find("TREE").unwrap();
        let probe_at = prompt.find("PROBE").unwrap();
        let session_at = prompt.find("SESSION").unwrap();
        assert!(tree_at < probe_at && probe_at < session_at, "{prompt}");
    }

    /// A transcript the ledger cannot name is said out loud, and assembly
    /// still completes.
    #[test]
    fn a_missing_transcript_is_named_as_missing() {
        let p = trip_prompt(vec![
            SessionTranscript {
                session_id: "sess-a".to_string(),
                transcript: Some(PathBuf::from("/t/sess-a.jsonl")),
            },
            SessionTranscript {
                session_id: "sess-gone".to_string(),
                transcript: None,
            },
        ]);
        let prompt = p.prompt("b", CONTRACT);
        assert!(prompt.contains("/t/sess-a.jsonl"), "{prompt}");
        assert!(
            prompt.contains("sess-gone — no transcript this instance can read"),
            "{prompt}"
        );
    }

    /// A hand-fired trip has no session at all, and the section says which
    /// rather than showing an empty list ([P08]).
    #[test]
    fn a_hand_fired_trip_names_no_session() {
        let prompt = trip_prompt(Vec::new()).prompt("b", CONTRACT);
        assert!(
            prompt.contains("No session: this trip was fired by hand."),
            "{prompt}"
        );
    }

    /// The fact's session names its transcript, and every earlier segment of
    /// the same line names its own.
    ///
    /// Against a real ledger and real files on disk, because the thing under
    /// test is the resolution — a stub would only prove the struct holds what
    /// it was handed.
    #[test]
    fn the_transcripts_resolve_every_named_session() {
        let claude = tempfile::tempdir().unwrap();
        let ledger = SessionLedger::open_in_memory_with_root(claude.path()).unwrap();
        let project = "/proj";
        let (dir, _) = crate::session_ledger::claude_project_dir(claude.path(), project);
        std::fs::create_dir_all(&dir).unwrap();

        for id in ["sess-a", "sess-b"] {
            ledger
                .record_spawn(id, project, project, "card-1", 1_000, id, None)
                .expect("spawn");
            std::fs::write(dir.join(format!("{id}.jsonl")), "{}\n").unwrap();
        }
        // A third session the ledger knows and whose transcript is not there.
        ledger
            .record_spawn(
                "sess-gone",
                project,
                project,
                "card-1",
                1_000,
                "sess-gone",
                None,
            )
            .expect("spawn");

        let one = session_transcripts(&ledger, &["sess-a".to_string()]);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].session_id, "sess-a");
        assert_eq!(
            one[0].transcript.as_deref(),
            Some(dir.join("sess-a.jsonl").as_path())
        );

        let all = session_transcripts(
            &ledger,
            &[
                "sess-a".to_string(),
                "sess-b".to_string(),
                "sess-gone".to_string(),
            ],
        );
        let named: Vec<&str> = all.iter().map(|e| e.session_id.as_str()).collect();
        assert_eq!(named, vec!["sess-a", "sess-b", "sess-gone"]);
        assert!(all[1].transcript.is_some());
        assert!(
            all[2].transcript.is_none(),
            "a transcript that is not on disk resolves to nothing, and the entry survives"
        );

        // And a session this ledger has never heard of is still an entry, so
        // the prompt can say it could not be read rather than omitting it.
        let unknown = session_transcripts(&ledger, &["sess-foreign".to_string()]);
        assert_eq!(unknown.len(), 1);
        assert!(unknown[0].transcript.is_none());
    }
}
