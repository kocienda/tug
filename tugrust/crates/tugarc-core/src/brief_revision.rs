//! A revised brief, read against the version a running arc opened on.
//!
//! An arc never changes the brief it opened on: its `brief.md` is the version
//! it is judged by. When a newer brief version is written while the arc runs,
//! the arc is marked stale, and this module says what the revision means for
//! it — which decisions were added, changed and removed, which of the arc's
//! finished steps carry a decision that moved, and which of the offers fits
//! best by default. Nothing here is stored. It is derived each time threads
//! are, from the two brief versions' bytes and the arc's own ledger, so it is
//! pure: the IO is `docket_threads::gather_inputs`'s.
//!
//! A decision is a paragraph that opens `**[B##] <title>.**`, the shape the
//! brief skeleton writes. A brief in another shape yields no decisions, which
//! reads as "nothing changed" only when both versions agree on that; any
//! uncited finished step sends the offer to `Pick`, so an unreadable brief
//! never pre-selects a wrong answer.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// One brief decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    /// `B07`.
    pub label: String,
    /// The bold run's text after the label, trailing `.` removed.
    pub title: String,
    /// The whole paragraph, whitespace runs collapsed.
    pub body: String,
}

/// A decision named on the revision, without its body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionRef {
    pub label: String,
    pub title: String,
}

impl From<&Decision> for DecisionRef {
    fn from(d: &Decision) -> Self {
        DecisionRef {
            label: d.label.clone(),
            title: d.title.clone(),
        }
    }
}

/// What moved between two versions of a brief.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DecisionDiff {
    pub added: Vec<DecisionRef>,
    pub changed: Vec<DecisionRef>,
    pub removed: Vec<DecisionRef>,
}

/// The offer a revision pre-selects. The user may always choose another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RevisionOffer {
    /// Only additions: keep going, and the additions become ideas.
    KeepGoing,
    /// No finished step carries a moved decision: a successor from the tip.
    SuccessorTip,
    /// A successor from the last finished step before the first one touched.
    SuccessorStep { after: u32 },
    /// The first finished step is touched: a successor from the fork point.
    SuccessorFork,
    /// A finished step says nothing of what it carries: the user picks.
    Pick,
}

/// The revision a stale live arc carries on its thread cell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevisionCell {
    pub from_version: u32,
    pub to_version: u32,
    pub added: Vec<DecisionRef>,
    pub changed: Vec<DecisionRef>,
    pub removed: Vec<DecisionRef>,
    /// Finished steps that carry a changed or removed decision.
    pub affected_steps: Vec<u32>,
    /// Finished steps whose citations say nothing.
    pub uncited_steps: Vec<u32>,
    pub done_steps: Vec<u32>,
    pub offer: RevisionOffer,
    /// The newest version the user chose to keep going past.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept_through: Option<u32>,
    #[serde(default)]
    pub parked: bool,
}

/// The label a paragraph's first line opens with, if it opens a decision:
/// `**[B` + two or more digits + `]`.
fn decision_label(first_line: &str) -> Option<&str> {
    let rest = first_line.trim_start().strip_prefix("**[")?;
    let close = rest.find(']')?;
    let label = &rest[..close];
    let digits = label.strip_prefix('B')?;
    (digits.len() >= 2 && digits.chars().all(|c| c.is_ascii_digit())).then_some(label)
}

/// Every decision in a brief's text, in order.
pub fn parse_decisions(text: &str) -> Vec<Decision> {
    let mut out = Vec::new();
    let mut paragraph: Vec<&str> = Vec::new();
    let mut flush = |paragraph: &mut Vec<&str>| {
        if let Some(first) = paragraph.first() {
            if let Some(label) = decision_label(first) {
                let after = first.trim_start()[3 + label.len()..].trim_start_matches(']');
                let title_run = match after.find("**") {
                    Some(end) => &after[..end],
                    None => after,
                };
                let title = title_run.trim().trim_end_matches('.').trim().to_string();
                let body = paragraph
                    .join(" ")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                out.push(Decision {
                    label: label.to_string(),
                    title,
                    body,
                });
            }
        }
        paragraph.clear();
    };
    for line in text.lines() {
        if line.trim().is_empty() {
            flush(&mut paragraph);
        } else {
            paragraph.push(line);
        }
    }
    flush(&mut paragraph);
    out
}

/// What moved from `from` to `to`: labels only in `to` are added, labels only
/// in `from` are removed, and labels in both whose bodies differ are changed.
pub fn diff(from: &[Decision], to: &[Decision]) -> DecisionDiff {
    let old: BTreeMap<&str, &Decision> = from.iter().map(|d| (d.label.as_str(), d)).collect();
    let new: BTreeMap<&str, &Decision> = to.iter().map(|d| (d.label.as_str(), d)).collect();
    DecisionDiff {
        added: to
            .iter()
            .filter(|d| !old.contains_key(d.label.as_str()))
            .map(DecisionRef::from)
            .collect(),
        changed: to
            .iter()
            .filter(|d| old.get(d.label.as_str()).is_some_and(|o| o.body != d.body))
            .map(DecisionRef::from)
            .collect(),
        removed: from
            .iter()
            .filter(|d| !new.contains_key(d.label.as_str()))
            .map(DecisionRef::from)
            .collect(),
    }
}

/// The revision a stale arc carries.
///
/// `citations` is `tugtool_core::plan::step_brief_citations` of the arc's
/// ledger; `done_steps` the steps its ledger reads `done`. The offer is the
/// first of four rules that matches:
///
/// 1. nothing changed or removed → keep going;
/// 2. a finished step says nothing of what it carries → the user picks;
/// 3. no finished step carries a moved decision → a successor from the tip;
/// 4. otherwise a successor from the last finished step below the first one
///    touched, or from the fork point when that is step one.
pub fn derive(
    from_version: u32,
    to_version: u32,
    diff: DecisionDiff,
    citations: &BTreeMap<u32, Option<BTreeSet<String>>>,
    done_steps: &[u32],
    kept_through: Option<u32>,
    parked: bool,
) -> RevisionCell {
    let mut done: Vec<u32> = done_steps.to_vec();
    done.sort_unstable();
    done.dedup();
    let moved: BTreeSet<&str> = diff
        .changed
        .iter()
        .chain(diff.removed.iter())
        .map(|d| d.label.as_str())
        .collect();
    let mut affected = Vec::new();
    let mut uncited = Vec::new();
    for step in &done {
        match citations.get(step) {
            Some(Some(carried)) => {
                if carried.iter().any(|l| moved.contains(l.as_str())) {
                    affected.push(*step);
                }
            }
            _ => uncited.push(*step),
        }
    }
    let offer = if moved.is_empty() {
        RevisionOffer::KeepGoing
    } else if !uncited.is_empty() {
        RevisionOffer::Pick
    } else if let Some(&first) = affected.first() {
        match done.iter().rev().find(|s| **s < first) {
            Some(&after) => RevisionOffer::SuccessorStep { after },
            None => RevisionOffer::SuccessorFork,
        }
    } else {
        RevisionOffer::SuccessorTip
    };
    RevisionCell {
        from_version,
        to_version,
        added: diff.added,
        changed: diff.changed,
        removed: diff.removed,
        affected_steps: affected,
        uncited_steps: uncited,
        done_steps: done,
        offer,
        kept_through,
        parked,
    }
}

/// The revision line `tugtool docket show` prints under a stale arc.
pub fn summary_line(cell: &RevisionCell) -> String {
    let touches = if cell.affected_steps.is_empty() {
        "no finished step".to_string()
    } else {
        format!(
            "steps {}",
            cell.affected_steps
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let offer = match cell.offer {
        RevisionOffer::KeepGoing => "keep going".to_string(),
        RevisionOffer::SuccessorTip => "a successor from the tip".to_string(),
        RevisionOffer::SuccessorStep { after } => format!("a successor after step {after}"),
        RevisionOffer::SuccessorFork => "a successor from the fork point".to_string(),
        RevisionOffer::Pick => "you pick the boundary".to_string(),
    };
    format!(
        "brief v{} → v{}: +{} ~{} −{}; touches {touches}; suggests {offer}",
        cell.from_version,
        cell.to_version,
        cell.added.len(),
        cell.changed.len(),
        cell.removed.len(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const BRIEF: &str = include_str!("../tests/fixtures/docket-loop-brief.md");

    fn cited(pairs: &[(u32, Option<&[&str]>)]) -> BTreeMap<u32, Option<BTreeSet<String>>> {
        pairs
            .iter()
            .map(|(n, labels)| {
                (
                    *n,
                    labels.map(|ls| ls.iter().map(|l| l.to_string()).collect()),
                )
            })
            .collect()
    }

    fn brief(decisions: &[(&str, &str)]) -> Vec<Decision> {
        let text: String = decisions
            .iter()
            .map(|(label, body)| format!("**[{label}] Title {label}.** {body}\n\n"))
            .collect();
        parse_decisions(&text)
    }

    #[test]
    fn this_arcs_own_brief_parses_to_eleven_decisions() {
        let decisions = parse_decisions(BRIEF);
        let labels: Vec<&str> = decisions.iter().map(|d| d.label.as_str()).collect();
        let want: Vec<String> = (1..=11).map(|n| format!("B{n:02}")).collect();
        assert_eq!(labels, want.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(
            decisions[0].title,
            "An arc never changes the brief it opened on"
        );
        assert!(
            decisions[6]
                .body
                .starts_with("**[B07] Stop leaves whole steps.**")
        );
    }

    #[test]
    fn added_only_keeps_going() {
        let from = brief(&[("B01", "one")]);
        let to = brief(&[("B01", "one"), ("B02", "two")]);
        let cell = derive(
            1,
            2,
            diff(&from, &to),
            &cited(&[(1, Some(&["B01"]))]),
            &[1],
            None,
            false,
        );
        assert_eq!(cell.offer, RevisionOffer::KeepGoing);
        assert_eq!(cell.added.len(), 1);
        assert!(cell.affected_steps.is_empty());
    }

    #[test]
    fn a_change_no_finished_step_carries_is_a_successor_from_the_tip() {
        let from = brief(&[("B01", "one"), ("B02", "two")]);
        let to = brief(&[("B01", "one"), ("B02", "two, revised")]);
        let c = cited(&[(1, Some(&["B01"])), (2, Some(&[]))]);
        let cell = derive(1, 2, diff(&from, &to), &c, &[1, 2], None, false);
        assert_eq!(cell.changed[0].label, "B02");
        assert_eq!(cell.offer, RevisionOffer::SuccessorTip);
    }

    #[test]
    fn a_change_step_three_carries_succeeds_after_step_two() {
        let from = brief(&[("B01", "one"), ("B02", "two")]);
        let to = brief(&[("B01", "one"), ("B02", "two, revised")]);
        let c = cited(&[
            (1, Some(&["B01"])),
            (2, Some(&["B01"])),
            (3, Some(&["B02"])),
            (4, Some(&["B01"])),
        ]);
        let cell = derive(1, 2, diff(&from, &to), &c, &[1, 2, 3, 4], None, false);
        assert_eq!(cell.affected_steps, vec![3]);
        assert_eq!(cell.offer, RevisionOffer::SuccessorStep { after: 2 });
    }

    #[test]
    fn a_change_step_one_carries_succeeds_from_the_fork() {
        let from = brief(&[("B01", "one")]);
        let to = brief(&[("B01", "one, revised")]);
        let c = cited(&[(1, Some(&["B01"])), (2, Some(&[]))]);
        let cell = derive(1, 2, diff(&from, &to), &c, &[1, 2], None, false);
        assert_eq!(cell.offer, RevisionOffer::SuccessorFork);
    }

    #[test]
    fn an_uncited_finished_step_asks_the_user_to_pick() {
        let from = brief(&[("B01", "one")]);
        let to = brief(&[("B01", "one, revised")]);
        let c = cited(&[(1, Some(&[])), (2, None)]);
        let cell = derive(1, 2, diff(&from, &to), &c, &[1, 2], None, false);
        assert_eq!(cell.uncited_steps, vec![2]);
        assert_eq!(cell.offer, RevisionOffer::Pick);
    }

    #[test]
    fn a_removed_decision_counts_as_moved() {
        let from = brief(&[("B01", "one"), ("B02", "two")]);
        let to = brief(&[("B01", "one")]);
        let c = cited(&[(1, Some(&["B01"])), (2, Some(&["B02"]))]);
        let cell = derive(1, 2, diff(&from, &to), &c, &[1, 2], None, false);
        assert_eq!(cell.removed[0].label, "B02");
        assert_eq!(cell.affected_steps, vec![2]);
        assert_eq!(cell.offer, RevisionOffer::SuccessorStep { after: 1 });
    }

    #[test]
    fn the_summary_line_names_the_counts_the_steps_and_the_offer() {
        let from = brief(&[("B01", "one"), ("B02", "two")]);
        let to = brief(&[("B01", "one"), ("B02", "two, revised"), ("B03", "three")]);
        let c = cited(&[(1, Some(&["B01"])), (2, Some(&["B02"]))]);
        let cell = derive(1, 3, diff(&from, &to), &c, &[1, 2], None, false);
        assert_eq!(
            summary_line(&cell),
            "brief v1 → v3: +1 ~1 −0; touches steps 2; suggests a successor after step 1"
        );
    }

    #[test]
    fn the_offer_serializes_with_its_kind() {
        let json = serde_json::to_string(&RevisionOffer::SuccessorStep { after: 2 }).unwrap();
        assert_eq!(json, r#"{"kind":"successor_step","after":2}"#);
    }
}
