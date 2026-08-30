//! The dossier — everything a fired wire's session is told, and nothing it
//! would have to reconstruct ([P03], Spec S03).
//!
//! **Assembled by the engine, on the engine's own task.** The landing path
//! just computed the provenance and must not wait for anybody to read it, so
//! the landing sends a small event and this module does the work afterwards:
//! the lineage union, the transcript paths, the commit's diff stat.
//!
//! **Paths rather than bytes, a stat rather than a diff.** The session reads
//! what it decides it needs; the prompt stays bounded whatever the landing's
//! size. A lineage source that cannot be read shrinks the dossier and is named
//! in it — never a silent gap, because a diagnosis working from half a history
//! it believes is whole is worse than one told which half it has.
//!
//! **Session ids rotate, so the lineage has two sources.** A landing names the
//! sessions it knew about; each of those is expanded through its line to every
//! segment id it has ever worn, and the union is what gets transcript paths.
//! Reading only the names the landing carried would miss the earlier half of
//! any session that rotated mid-work.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::session_ledger::SessionLedger;

/// How much of a landing's stat output rides in the prompt. A stat is one line
/// per file, so this is generous for an ordinary landing and a bound on the
/// one that touched a thousand.
const DIFF_STAT_CAP: usize = 4_000;

/// One lineage session, resolved as far as this instance's ledger can.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageEntry {
    pub session_id: String,
    /// The transcript on disk, or `None` when the ledger cannot name the
    /// session or the file is not there. Either way the entry survives — a
    /// session that cannot be read is a fact about the dossier.
    pub transcript: Option<PathBuf>,
}

/// The landing a trip was claimed for, read back off the row it wrote.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Landing {
    pub kind: String,
    pub branch: String,
    pub sha: String,
    pub repo_root: String,
    pub dash: Option<String>,
    pub session_ids: Vec<String>,
}

/// What a firing knows, composed once and rendered into the prompts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dossier {
    pub landing: Landing,
    /// The commit's `--stat`, or `None` when the repository could not be read.
    pub diff_stat: Option<String>,
    /// The facts that matched, as the trip row holds them.
    pub facts: Vec<String>,
    pub lineage: Vec<LineageEntry>,
    /// The probe's exit and output tail, when the wire has one and it failed
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

/// Read the landing back out of a trip row's evidence.
///
/// Off the row rather than out of memory, because a trip drained from the
/// queue minutes later must compose the same dossier as one worked
/// immediately: the live event is gone by then, and the row is the only record
/// of it there is.
pub fn landing_from_payload(payload: &str) -> Landing {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        return Landing::default();
    };
    let landing = value
        .get("landing")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let text = |name: &str| {
        landing
            .get(name)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    Landing {
        kind: text("kind"),
        branch: text("branch"),
        sha: text("sha"),
        repo_root: text("repo_root"),
        dash: landing
            .get("dash")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        session_ids: landing
            .get("sessions")
            .and_then(|v| v.as_array())
            .map(|rows| {
                rows.iter()
                    .filter_map(|v| v.as_str())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// The matched facts, rendered one to a line the way the trip evidence reads.
pub fn facts_from_payload(payload: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        return Vec::new();
    };
    value
        .get("facts")
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    let field = |name: &str| row.get(name).and_then(|v| v.as_str()).unwrap_or("");
                    let payload = row
                        .get("payload")
                        .map(|p| p.to_string())
                        .unwrap_or_else(|| "{}".to_string());
                    format!("{} — {} {}", field("kind"), field("text"), payload)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Expand the landing's sessions to every id their lines have worn, and
/// resolve each to a transcript.
///
/// Both sources are read because ids rotate: the landing names the sessions it
/// knew about, and the ledger's line records name the segments those sessions
/// were before. A landing that carried a rotated tip and nothing else would
/// otherwise hand the diagnosis the last few turns of the work and call it the
/// history.
pub fn resolve_lineage(ledger: &SessionLedger, session_ids: &[String]) -> Vec<LineageEntry> {
    expand_lineage(ledger, session_ids)
        .into_iter()
        .map(|session_id| LineageEntry {
            transcript: transcript_path(ledger, &session_id),
            session_id,
        })
        .collect()
}

/// The landing's sessions, expanded through their lines to every id each has
/// worn, sorted and deduplicated.
///
/// Split out from [`resolve_lineage`] because the expansion is not only the
/// dossier's business: the facts the predicate reads are attributed per
/// session id, so a landing evaluated against the tip id alone would miss
/// everything an earlier segment of the same work recorded — a wire that
/// silently does not fire, which is worse than one that fires on nothing.
pub fn expand_lineage(ledger: &SessionLedger, session_ids: &[String]) -> Vec<String> {
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

/// The landed commit's `--stat`, read against its first parent.
///
/// A stat rather than the diff: what the diagnosis needs is which files moved
/// and by how much, and the bytes it decides it wants are one command away in
/// a checkout it is already standing in.
pub async fn diff_stat(repo_root: &Path, sha: &str) -> Option<String> {
    if sha.is_empty() {
        return None;
    }
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args([
            "show",
            "--stat",
            "--oneline",
            "--no-color",
            "-m",
            "--first-parent",
        ])
        .arg(sha)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some(cap(&text, DIFF_STAT_CAP))
}

fn cap(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.to_string();
    }
    let mut end = cap;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (truncated)", &text[..end])
}

impl Dossier {
    /// The prompt a fired wire's session is handed, in the section order
    /// Spec S03 fixes: brief, landing, probe, evidence, lineage, contract.
    ///
    /// Everything but the closing contract is the same whatever the session
    /// is for, because it is the same firing being described. The contract is
    /// what changes between phases, so it is the caller's to supply — and this
    /// is the one place the order lives.
    pub fn prompt(&self, brief: &str, contract: &str) -> String {
        let mut out = String::new();
        out.push_str("BRIEF\n");
        out.push_str(brief.trim());
        out.push_str("\n\nLANDING\n");
        out.push_str(&self.landing_section());
        if let Some(probe) = &self.probe {
            out.push_str("\n\nPROBE\n");
            out.push_str(&format!(
                "`{}` exited {}. Its output ends:\n{}",
                probe.command,
                probe.exit,
                probe.tail.trim()
            ));
        }
        out.push_str("\n\nEVIDENCE\n");
        out.push_str(&self.evidence_section());
        out.push_str("\n\nLINEAGE\n");
        out.push_str(&self.lineage_section());
        out.push_str("\n\nCONTRACT\n");
        out.push_str(contract.trim());
        out
    }

    /// The prompt the *authoring* session is handed (Spec S03) — composed only
    /// when the diagnosis session asked for one.
    ///
    /// Shorter than the diagnosis prompt on purpose. The evidence has already
    /// been read by a session that stood at the commit and said what it found,
    /// so re-showing the raw facts here would invite a second diagnosis instead
    /// of the change that was asked for. What survives is the brief, the
    /// landing, the ask, and the first session's own words.
    pub fn authoring_prompt(
        &self,
        brief: &str,
        ask: &str,
        findings: &str,
        contract: &str,
    ) -> String {
        let mut out = String::new();
        out.push_str("BRIEF\n");
        out.push_str(brief.trim());
        out.push_str("\n\nLANDING\n");
        out.push_str(&self.landing_section());
        out.push_str("\n\nASK\n");
        out.push_str(ask.trim());
        out.push_str("\n\nFINDINGS\n");
        let findings = findings.trim();
        if findings.is_empty() {
            out.push_str(
                "The session that diagnosed this left no closing words. The ask above is the \
                 whole of what it passed on.",
            );
        } else {
            out.push_str(findings);
        }
        out.push_str("\n\nCONTRACT\n");
        out.push_str(contract.trim());
        out
    }

    fn landing_section(&self) -> String {
        let mut out = format!(
            "A {} landed {} onto {} in {}.",
            self.landing.kind,
            short_sha(&self.landing.sha),
            self.landing.branch,
            self.landing.repo_root
        );
        if let Some(dash) = &self.landing.dash {
            out.push_str(&format!(" It joined the dash `{dash}`."));
        }
        match &self.diff_stat {
            Some(stat) => out.push_str(&format!("\n\n{stat}")),
            None => out.push_str("\n\nIts diff stat could not be read."),
        }
        out
    }

    fn evidence_section(&self) -> String {
        if self.facts.is_empty() {
            return "No facts matched — this firing carries the landing alone.".to_string();
        }
        self.facts.join("\n")
    }

    fn lineage_section(&self) -> String {
        if self.lineage.is_empty() {
            return "This landing named no sessions, so there is no transcript to read."
                .to_string();
        }
        let mut out =
            String::from("These transcripts are the history behind the commit, and may be read:\n");
        for entry in &self.lineage {
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

fn short_sha(sha: &str) -> &str {
    if sha.len() >= 9 { &sha[..9] } else { sha }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(sessions: &[&str], facts: usize) -> String {
        let facts: Vec<serde_json::Value> = (0..facts)
            .map(|i| {
                serde_json::json!({
                    "id": i + 1,
                    "kind": "edit_failed",
                    "text": format!("edit {i} went stale"),
                    "payload": {"class": "resolve"},
                })
            })
            .collect();
        serde_json::json!({
            "landing": {
                "kind": "commit",
                "branch": "main",
                "sha": "abc123def456",
                "repo_root": "/proj",
                "dash": null,
                "sessions": sessions,
            },
            "facts": facts,
        })
        .to_string()
    }

    fn dossier(lineage: Vec<LineageEntry>) -> Dossier {
        let raw = payload(&["sess-a"], 1);
        Dossier {
            landing: landing_from_payload(&raw),
            diff_stat: Some("abc123d one\n a.rs | 2 +-".to_string()),
            facts: facts_from_payload(&raw),
            lineage,
            probe: None,
        }
    }

    /// The closing contract a test supplies, standing in for whatever phase's
    /// contract the engine passes.
    const CONTRACT: &str = "You are working on the dash `tripwire-ci-abcd1234`. \
                            Close your turn with one JSON object.";

    #[test]
    fn a_landing_reads_back_off_the_row_it_wrote() {
        let landing = landing_from_payload(&payload(&["sess-a", "sess-b"], 0));
        assert_eq!(landing.kind, "commit");
        assert_eq!(landing.branch, "main");
        assert_eq!(landing.sha, "abc123def456");
        assert_eq!(landing.repo_root, "/proj");
        assert_eq!(landing.dash, None);
        assert_eq!(landing.session_ids, vec!["sess-a", "sess-b"]);
    }

    /// An unreadable payload is an empty landing rather than a panic: the row
    /// belongs to whatever build wrote it, and a newer shape must not take the
    /// engine down.
    #[test]
    fn an_unreadable_payload_is_an_empty_landing() {
        assert_eq!(landing_from_payload("not json"), Landing::default());
        assert!(facts_from_payload("not json").is_empty());
    }

    /// The prompt's section order is the spec's, and a reader who saw none of
    /// the run can follow it top to bottom.
    #[test]
    fn the_prompt_carries_every_section_in_the_order_the_spec_fixes() {
        let d = dossier(vec![LineageEntry {
            session_id: "sess-a".to_string(),
            transcript: Some(PathBuf::from("/t/sess-a.jsonl")),
        }]);
        let prompt = d.prompt("diagnose the failure", CONTRACT);

        let order = ["BRIEF", "LANDING", "EVIDENCE", "LINEAGE", "CONTRACT"];
        let mut at = 0;
        for section in order {
            let found = prompt[at..]
                .find(section)
                .unwrap_or_else(|| panic!("{section} is missing or out of order in:\n{prompt}"));
            at += found + section.len();
        }
        assert!(prompt.contains("a.rs | 2 +-"), "{prompt}");
        assert!(prompt.contains("/t/sess-a.jsonl"), "{prompt}");
        assert!(prompt.contains("edit 0 went stale"), "{prompt}");
        assert!(
            prompt.contains("`tripwire-ci-abcd1234`"),
            "the caller's contract states the dash by name: {prompt}"
        );
        assert!(!prompt.contains("PROBE"), "no probe on this wire: {prompt}");
    }

    /// A failed probe's tail rides in the prompt, not only in the trip row.
    #[test]
    fn a_failed_probe_is_a_section_of_its_own() {
        let mut d = dossier(Vec::new());
        d.probe = Some(ProbeReport {
            command: "just ci".to_string(),
            exit: 3,
            tail: "error[E0425]: cannot find value".to_string(),
        });
        let prompt = d.prompt("diagnose the failure", CONTRACT);
        assert!(prompt.contains("`just ci` exited 3"), "{prompt}");
        assert!(prompt.contains("error[E0425]"), "{prompt}");
        let landing_at = prompt.find("LANDING").unwrap();
        let probe_at = prompt.find("PROBE").unwrap();
        let evidence_at = prompt.find("EVIDENCE").unwrap();
        assert!(landing_at < probe_at && probe_at < evidence_at, "{prompt}");
    }

    /// A transcript the ledger cannot name is said out loud, and assembly
    /// still completes ([P03]).
    #[test]
    fn a_missing_transcript_is_named_as_missing() {
        let d = dossier(vec![
            LineageEntry {
                session_id: "sess-a".to_string(),
                transcript: Some(PathBuf::from("/t/sess-a.jsonl")),
            },
            LineageEntry {
                session_id: "sess-gone".to_string(),
                transcript: None,
            },
        ]);
        let prompt = d.prompt("b", CONTRACT);
        assert!(prompt.contains("/t/sess-a.jsonl"), "{prompt}");
        assert!(
            prompt.contains("sess-gone — no transcript this instance can read"),
            "{prompt}"
        );
    }

    #[test]
    fn a_landing_with_no_sessions_says_so_rather_than_showing_an_empty_list() {
        let d = dossier(Vec::new());
        let prompt = d.prompt("b", CONTRACT);
        assert!(prompt.contains("named no sessions"), "{prompt}");
    }

    /// A commit landing names its drafting session's transcript; a join
    /// landing names every bound session's ([P03]).
    ///
    /// Against a real ledger and real files on disk, because the thing under
    /// test is the resolution — a stub would only prove the struct holds what
    /// it was handed.
    #[test]
    fn the_lineage_resolves_every_named_session_to_its_transcript() {
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

        // A commit landing names one.
        let one = resolve_lineage(&ledger, &["sess-a".to_string()]);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].session_id, "sess-a");
        assert_eq!(
            one[0].transcript.as_deref(),
            Some(dir.join("sess-a.jsonl").as_path())
        );

        // A join landing names every session bound to the dash it landed.
        let all = resolve_lineage(
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
        // the dossier can say it could not be read rather than omitting it.
        let unknown = resolve_lineage(&ledger, &["sess-foreign".to_string()]);
        assert_eq!(unknown.len(), 1);
        assert!(unknown[0].transcript.is_none());
    }
}
