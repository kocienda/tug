//! Chain-aware record selection — the Rust half of tugcode's
//! `computeDeadEntryIndices` (`tugcode/src/replay.ts`).
//!
//! A session JSONL is an append-only `parentUuid` tree, not a list.
//! History edits never remove bytes; they abandon them. A conversation
//! rewind branches — the next submission parents to an ancestor, stranding
//! everything after the branch point — and the REPL's pre-response Escape
//! leaves the aborted prompt as an orphan. Claude resumes by walking the
//! chain from the newest leaf, so those records never re-enter its
//! context. Anything that counts or renders them counts phantom turns.
//!
//! Two computations live here, mirroring the TS walk decision-for-decision:
//!
//! - [`compute_dead_entry_indices`] — the *dead* set: the descendant
//!   closure of off-chain user submissions whose resolved parent is live.
//!   Off-chain alone is not dead; real files carry benign mid-turn spurs
//!   (hook attachments, a `tool_result` whose sibling carried the chain
//!   forward) and whole null-parent segments, all of which stay visible.
//! - [`effective_indices`] — the *effective record sequence*: live records
//!   with re-appended duplicate occurrences suppressed, keeping the
//!   earliest non-dead occurrence of each uuid.
//!
//! ## A uuid names several records
//!
//! Claude Code re-appends a compaction's preserved messages verbatim —
//! same `uuid`, same `parentUuid`, a later file position. Parent
//! resolution must therefore respect the invariant the whole walk rests
//! on: **a parent always precedes its child**. Resolving a `parentUuid`
//! to the file's last occurrence sends the ancestor walk FORWARD into the
//! re-appended copy, where it meets an already-live record and stops; the
//! segment root is then an ordinary assistant record, no compaction bridge
//! fires, and the dead-roots sweep discards the history the walk never
//! visited. [`resolve_parent`] takes the newest occurrence strictly before
//! the child, and `None` for a uuid that appears only later.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Deserialize;

/// The fields the chain walk reads from a JSONL line. Everything else —
/// the assistant content tree, tool payloads, cwd/version bookkeeping — is
/// left unparsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainRecord {
    pub uuid: Option<String>,
    pub parent_uuid: Option<String>,
    pub is_sidechain: bool,
    /// A `compact_boundary` system record or an `isCompactSummary` user
    /// record — where the chain breaks at a `/compact`.
    pub is_compaction: bool,
    /// A genuine user submission: string content, or blocks carrying at
    /// least one non-`tool_result` block. Only these root a dead branch.
    pub is_user_submission: bool,
}

#[derive(Deserialize)]
struct RawRecord<'a> {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    uuid: Option<String>,
    #[serde(rename = "parentUuid", default)]
    parent_uuid: Option<String>,
    #[serde(rename = "isSidechain", default)]
    is_sidechain: Option<bool>,
    #[serde(rename = "isCompactSummary", default)]
    is_compact_summary: Option<bool>,
    #[serde(default, borrow)]
    message: Option<&'a serde_json::value::RawValue>,
}

#[derive(Deserialize, Default)]
struct MessageContent {
    #[serde(default)]
    content: Option<serde_json::Value>,
}

/// Parse one JSONL line into a [`ChainRecord`], or `None` when the line is
/// blank or malformed. Mirrors tugcode, where an unparseable line becomes a
/// `null` entry that still occupies its index — so callers must keep the
/// `None`s to stay index-aligned with the file.
pub fn parse_chain_record(line: &str) -> Option<ChainRecord> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let raw = serde_json::from_str::<RawRecord>(trimmed).ok()?;
    let is_compact_summary = raw.is_compact_summary == Some(true);
    let is_compaction = (raw.kind.as_deref() == Some("system")
        && raw.subtype.as_deref() == Some("compact_boundary"))
        || is_compact_summary;

    let is_user_submission = if raw.kind.as_deref() == Some("user") {
        let content = raw
            .message
            .and_then(|m| serde_json::from_str::<MessageContent>(m.get()).ok())
            .and_then(|m| m.content);
        match content {
            Some(serde_json::Value::String(s)) => !s.is_empty(),
            Some(serde_json::Value::Array(blocks)) => blocks
                .iter()
                .any(|b| b.get("type").and_then(|t| t.as_str()) != Some("tool_result")),
            _ => false,
        }
    } else {
        false
    };

    Some(ChainRecord {
        uuid: raw.uuid.filter(|u| !u.is_empty()),
        parent_uuid: raw.parent_uuid,
        is_sidechain: raw.is_sidechain == Some(true),
        is_compaction,
        is_user_submission,
    })
}

/// Parse a whole JSONL string, keeping one slot per line so indices match
/// the file's line numbering.
pub fn parse_chain_records(jsonl: &str) -> Vec<Option<ChainRecord>> {
    jsonl.lines().map(parse_chain_record).collect()
}

/// The chain participants and their edges: uuid-bearing, non-sidechain
/// records.
struct ChainIndex {
    /// Positions of chain participants, ascending.
    chain_indices: Vec<usize>,
    /// Every position each uuid appears at, ascending.
    occurrences: HashMap<String, Vec<usize>>,
    /// Positions parented to each uuid, ascending.
    children: HashMap<String, Vec<usize>>,
}

fn index_chain(records: &[Option<ChainRecord>]) -> ChainIndex {
    let mut occurrences: HashMap<String, Vec<usize>> = HashMap::new();
    let mut children: HashMap<String, Vec<usize>> = HashMap::new();
    let mut chain_indices: Vec<usize> = Vec::new();
    for (i, slot) in records.iter().enumerate() {
        let Some(rec) = slot else { continue };
        if rec.is_sidechain {
            continue;
        }
        let Some(uuid) = rec.uuid.as_ref() else {
            continue;
        };
        occurrences.entry(uuid.clone()).or_default().push(i);
        chain_indices.push(i);
        if let Some(parent) = rec.parent_uuid.as_ref() {
            children.entry(parent.clone()).or_default().push(i);
        }
    }
    ChainIndex {
        chain_indices,
        occurrences,
        children,
    }
}

/// The newest occurrence of `parent_uuid` strictly before `child_index`.
/// `None` when the uuid is unknown or appears only later — a forward edge
/// is not a parent. Occurrence lists are ascending, so this is a binary
/// search for the rightmost entry below `child_index`.
fn resolve_parent(index: &ChainIndex, child_index: usize, parent_uuid: &str) -> Option<usize> {
    let at = index.occurrences.get(parent_uuid)?;
    let pos = at.partition_point(|&i| i < child_index);
    if pos == 0 { None } else { Some(at[pos - 1]) }
}

/// The live set: the ancestor closure of the newest leaf, bridged
/// backwards across `/compact` chain breaks. A segment that roots at a
/// compaction record has hit a `/compact`, not the session start — bridge
/// to the newest chain record before it and keep walking, because
/// pre-compaction history is display-relevant even though it left claude's
/// context.
fn compute_live_indices(records: &[Option<ChainRecord>], index: &ChainIndex) -> HashSet<usize> {
    let mut live: HashSet<usize> = HashSet::new();
    let Some(&last) = index.chain_indices.last() else {
        return live;
    };

    let mut cursor = Some(last);
    while let Some(start) = cursor {
        // Walk this segment's chain upward. The `live` check breaks cycles
        // in a corrupt file and stops when a bridge merges into an
        // already-live record.
        let mut root_index = start;
        let mut walk = Some(start);
        while let Some(at) = walk {
            if live.contains(&at) {
                break;
            }
            live.insert(at);
            root_index = at;
            walk = records[at]
                .as_ref()
                .and_then(|r| r.parent_uuid.as_deref())
                .and_then(|p| resolve_parent(index, at, p));
        }

        cursor = None;
        let roots_at_compaction = records[root_index]
            .as_ref()
            .map(|r| r.is_compaction)
            .unwrap_or(false);
        if roots_at_compaction {
            for &candidate in index.chain_indices.iter().rev() {
                if candidate < root_index && !live.contains(&candidate) {
                    cursor = Some(candidate);
                    break;
                }
            }
        }
    }
    live
}

/// Records that are OFF the session's live chain and must not replay or
/// count: the descendant closure of off-chain user submissions whose
/// resolved parent is live — the exact shape a rewind strands.
///
/// Requiring a live parent is what separates a rewound-away turn from a
/// restart segment (whose root has no parent at all). Records with no
/// `uuid` (bookkeeping) and sidechain records (they root their own chains
/// mid-file) are never dead.
pub fn compute_dead_entry_indices(records: &[Option<ChainRecord>]) -> HashSet<usize> {
    let index = index_chain(records);
    if index.chain_indices.is_empty() {
        return HashSet::new();
    }
    let live = compute_live_indices(records, &index);

    let mut dead: HashSet<usize> = HashSet::new();
    let mut queue: VecDeque<usize> = VecDeque::new();
    for &i in &index.chain_indices {
        if live.contains(&i) {
            continue;
        }
        let Some(rec) = records[i].as_ref() else {
            continue;
        };
        if !rec.is_user_submission {
            continue;
        }
        let parent_index = rec
            .parent_uuid
            .as_deref()
            .and_then(|p| resolve_parent(&index, i, p));
        if parent_index.is_some_and(|p| live.contains(&p)) {
            queue.push_back(i);
        }
    }

    while let Some(i) = queue.pop_back() {
        if !dead.insert(i) {
            continue;
        }
        let Some(uuid) = records[i].as_ref().and_then(|r| r.uuid.as_deref()) else {
            continue;
        };
        let Some(kids) = index.children.get(uuid) else {
            continue;
        };
        for &child in kids {
            // `children` is keyed by uuid, so a re-appended duplicate's
            // children pool with this record's. Descend only into the
            // children that actually parent to THIS occurrence.
            if resolve_parent(&index, child, uuid) != Some(i) {
                continue;
            }
            if !dead.contains(&child) {
                queue.push_back(child);
            }
        }
    }
    dead
}

/// The effective record sequence: the indices that segmentation and replay
/// both operate on. A record is effective when it is not dead and, for a
/// chain participant, is the earliest non-dead occurrence of its uuid.
///
/// "Earliest **non-dead**" rather than simply "first" covers the corner
/// where an original occurrence was legitimately swept as a dead branch
/// while its re-appended copy is live preserved content.
///
/// Sidechain and uuid-less records are never suppressed — they are outside
/// the chain's index domain entirely.
pub fn effective_indices(records: &[Option<ChainRecord>]) -> Vec<usize> {
    let dead = compute_dead_entry_indices(records);
    let mut emitted: HashSet<&str> = HashSet::new();
    let mut out: Vec<usize> = Vec::new();
    for (i, slot) in records.iter().enumerate() {
        if dead.contains(&i) {
            continue;
        }
        let Some(rec) = slot else { continue };
        match rec.uuid.as_deref() {
            Some(uuid) if !rec.is_sidechain => {
                if emitted.insert(uuid) {
                    out.push(i);
                }
            }
            _ => out.push(i),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The committed projection of a real 4-compaction session's re-append
    /// region — the same fixture `replay-compact-reappend.test.ts` pins the
    /// TS walk against, so both halves are measured on one topology.
    fn fixture_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tugcode/src/__tests__/fixtures/compact-reappend/chain-topology.jsonl")
    }

    fn fixture_records() -> Vec<Option<ChainRecord>> {
        let jsonl =
            std::fs::read_to_string(fixture_path()).expect("read chain-topology.jsonl fixture");
        parse_chain_records(&jsonl)
    }

    #[test]
    fn fixture_carries_the_topology_the_walk_has_to_survive() {
        let records = fixture_records();
        assert_eq!(records.len(), 1211);

        let index = index_chain(&records);
        assert_eq!(index.chain_indices.len(), 1001);

        let duplicated: Vec<&Vec<usize>> = index
            .occurrences
            .values()
            .filter(|at| at.len() > 1)
            .collect();
        assert_eq!(duplicated.len(), 362);
        assert!(duplicated.iter().all(|at| at.len() == 2));

        let firsts: Vec<usize> = duplicated.iter().map(|at| at[0]).collect();
        let seconds: Vec<usize> = duplicated.iter().map(|at| at[1]).collect();
        assert_eq!(
            (*firsts.iter().min().unwrap(), *firsts.iter().max().unwrap()),
            (3, 512)
        );
        assert_eq!(
            (
                *seconds.iter().min().unwrap(),
                *seconds.iter().max().unwrap()
            ),
            (834, 1195)
        );

        let compaction: Vec<usize> = records
            .iter()
            .enumerate()
            .filter(|(_, r)| r.as_ref().is_some_and(|r| r.is_compaction))
            .map(|(i, _)| i)
            .collect();
        assert_eq!(compaction, vec![14, 15, 523, 524, 834, 835, 1196, 1197]);
    }

    #[test]
    fn fixture_has_no_dead_branch() {
        // Same value the TS walk reports on this fixture: a compaction
        // re-append is not an abandoned branch.
        let records = fixture_records();
        assert!(compute_dead_entry_indices(&records).is_empty());
    }

    #[test]
    fn fixture_live_set_matches_the_ts_measurement() {
        // 44 of the 1001 chain records are benign off-chain spurs — hook
        // attachments, tool_result records whose sibling carried the chain
        // forward. Off-chain is not dead; they stay visible.
        let records = fixture_records();
        let index = index_chain(&records);
        let live = compute_live_indices(&records, &index);
        assert_eq!(index.chain_indices.len() - live.len(), 44);
    }

    #[test]
    fn effective_sequence_drops_exactly_the_re_appended_copies() {
        let records = fixture_records();
        let effective = effective_indices(&records);
        // Nothing is dead here, so the only losses are the 362 re-appended
        // duplicate occurrences.
        assert_eq!(records.len() - effective.len(), 362);

        // The occurrence kept is the earliest one.
        let index = index_chain(&records);
        let kept: HashSet<usize> = effective.iter().copied().collect();
        for at in index.occurrences.values().filter(|at| at.len() > 1) {
            assert!(
                kept.contains(&at[0]),
                "earliest occurrence {} dropped",
                at[0]
            );
            assert!(!kept.contains(&at[1]), "later occurrence {} kept", at[1]);
        }
    }

    #[test]
    fn resolve_parent_never_walks_forward() {
        let records = fixture_records();
        let index = index_chain(&records);
        for &i in &index.chain_indices {
            let Some(parent) = records[i].as_ref().and_then(|r| r.parent_uuid.as_deref()) else {
                continue;
            };
            if let Some(p) = resolve_parent(&index, i, parent) {
                assert!(p < i, "record {i} resolved its parent forward to {p}");
            }
        }
    }

    #[test]
    fn sidechain_and_uuidless_records_are_never_dead_or_suppressed() {
        let jsonl = r#"
{"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"first"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[]}}
{"type":"user","uuid":"side","parentUuid":"a1","isSidechain":true,"message":{"role":"user","content":"sidechain"}}
{"type":"last-prompt"}
{"type":"user","uuid":"side","parentUuid":"a1","isSidechain":true,"message":{"role":"user","content":"sidechain again"}}
{"type":"user","uuid":"u2","parentUuid":"a1","message":{"role":"user","content":"second"}}
"#;
        let records = parse_chain_records(jsonl);
        assert!(compute_dead_entry_indices(&records).is_empty());
        // Every non-blank line survives: the repeated `side` uuid is outside
        // the chain index domain, so it is not deduplicated.
        let effective = effective_indices(&records);
        assert_eq!(effective.len(), 6);
    }

    // The corpus sessions live outside the repo and are written while the
    // suite runs, so the sweep both skips gracefully when absent and drops
    // any file that moves mid-run (`StillFiles`).
    use crate::live_corpus::{StillFiles, reference_corpus_dir, tugcode_bin};

    /// The dead-branch parity contract: for every session in the real local
    /// corpus, this port's dead set equals tugcode's (`tugcode dead <dir>`),
    /// index for index. The drift gate that keeps the two walks one
    /// algorithm rather than two implementations of a description.
    #[test]
    fn dead_sets_match_tugcode_over_real_corpus() {
        let dir = reference_corpus_dir();
        if !dir.is_dir() {
            eprintln!("skipping: real corpus not present at {}", dir.display());
            return;
        }
        let bin = tugcode_bin();
        if !bin.exists() {
            eprintln!(
                "skipping: tugcode binary not present at {} (set TUGCODE_BIN or build it)",
                bin.display()
            );
            return;
        }

        let mut still = StillFiles::stamp(&dir);

        let output = std::process::Command::new(&bin)
            .arg("dead")
            .arg(&dir)
            .output()
            .expect("spawn tugcode dead");
        assert!(
            output.status.success(),
            "tugcode dead failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let tugcode_map: std::collections::BTreeMap<String, Vec<usize>> =
            serde_json::from_slice(&output.stdout).expect("parse tugcode dead JSON");
        assert!(
            !tugcode_map.is_empty(),
            "tugcode walked zero files — corpus empty or unreadable"
        );

        let mut divergences: Vec<String> = Vec::new();
        let mut compared = 0usize;
        let mut non_empty = 0usize;
        for (base, tugcode_dead) in &tugcode_map {
            let path = dir.join(base);
            let Ok(jsonl) = std::fs::read_to_string(&path) else {
                continue;
            };
            if !still.still(&path) {
                continue;
            }
            let records = parse_chain_records(&jsonl);
            let mut ours: Vec<usize> = compute_dead_entry_indices(&records).into_iter().collect();
            ours.sort_unstable();
            compared += 1;
            if !tugcode_dead.is_empty() {
                non_empty += 1;
            }
            if &ours != tugcode_dead {
                divergences.push(format!(
                    "{base}: rust={} tugcode={} (first differing: {:?} vs {:?})",
                    ours.len(),
                    tugcode_dead.len(),
                    ours.iter().take(5).collect::<Vec<_>>(),
                    tugcode_dead.iter().take(5).collect::<Vec<_>>()
                ));
            }
        }

        eprintln!(
            "dead-branch parity: compared {compared} sessions ({non_empty} with a non-empty dead set), {} divergent, {} skipped (written during the run)",
            divergences.len(),
            still.skipped()
        );
        assert!(
            divergences.is_empty(),
            "rust dead set != tugcode on {} session(s):\n{}",
            divergences.len(),
            divergences.join("\n")
        );
        // A corpus-dependent test skips when the corpus lacks its case rather
        // than failing over it. A machine whose sessions happen to contain no
        // `/rewind` and no compaction has nothing for the parity comparison to
        // prove — every dead set is empty on both sides, which is agreement,
        // not silence. The guard against detection actually going silent is
        // `adversarial_fixture_dead_set_matches_the_ts_walk`, which walks a
        // committed session with a real dead branch and does not depend on
        // what this machine happens to hold.
        if non_empty == 0 {
            eprintln!(
                "note: {compared} corpus session(s) walked and none has a dead branch, so parity here is vacuous — the non-vacuous check is `adversarial_fixture_dead_set_matches_the_ts_walk`"
            );
        }
    }

    /// The generated adversarial session (a real `/rewind` branch alongside
    /// three compactions). Rust and TS must agree on it index for index —
    /// the same values `replay-compact-reappend.test.ts` pins.
    #[test]
    fn adversarial_fixture_dead_set_matches_the_ts_walk() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../../../tugcode/src/__tests__/fixtures/compact-reappend/rewind-and-compact.jsonl",
        );
        let jsonl = std::fs::read_to_string(path).expect("read rewind-and-compact.jsonl fixture");
        let records = parse_chain_records(&jsonl);
        assert_eq!(records.len(), 117);

        let mut dead: Vec<usize> = compute_dead_entry_indices(&records).into_iter().collect();
        dead.sort_unstable();
        assert_eq!(dead, vec![35, 36, 37, 38, 40, 41, 42, 43]);

        // No duplicated uuids in this one, so the effective sequence loses
        // exactly the dead branch and nothing else.
        assert_eq!(records.len() - effective_indices(&records).len(), 8);
    }

    #[test]
    fn a_rewind_branch_is_dead_and_its_descendants_with_it() {
        // u2/a2 are stranded when u3 parents back to a1.
        let jsonl = r#"
{"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"first"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[]}}
{"type":"user","uuid":"u2","parentUuid":"a1","message":{"role":"user","content":"abandoned"}}
{"type":"assistant","uuid":"a2","parentUuid":"u2","message":{"role":"assistant","content":[]}}
{"type":"user","uuid":"u3","parentUuid":"a1","message":{"role":"user","content":"kept"}}
{"type":"assistant","uuid":"a3","parentUuid":"u3","message":{"role":"assistant","content":[]}}
"#;
        let records = parse_chain_records(jsonl);
        let dead = compute_dead_entry_indices(&records);
        let mut got: Vec<usize> = dead.into_iter().collect();
        got.sort_unstable();
        assert_eq!(got, vec![3, 4]);
    }
}
