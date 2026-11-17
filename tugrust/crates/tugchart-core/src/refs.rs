//! The refs a recipe puts beside its numbers: what each bucket is about.
//!
//! A chart of commits per day is a chart about commits, and a bar that
//! stands for 57 of them can carry them, so a reader can open one from the
//! chart. The spec's rule is in `tuggraphics::chart::spec`: a slot is one
//! ref, an array of up to `MAX_SET` refs of one prefix, or a `{kind, count}`
//! form past that, and a spec carries at most `MAX_REFS` members in all.
//!
//! Every recipe spends its members through one [`RefBudget`], and the budget
//! is spent **newest bucket first**: the chart's right edge is what a reader
//! reaches for, so when a spec cannot carry every commit it is the oldest
//! days that fold into counts. A count form still says how many and is
//! still right; the list it folded is in the recipe's member table
//! (`crate::members`), which a press on the count reads back through the
//! spec's `source` as a paged report. The cap exists for the Bash result a
//! recipe's `TUG-CHART:` line rides in, which is truncated past 30,000
//! characters (Risk R01); the budget keeps a 90-day `commits` spec well
//! under that.

use serde_json::{Value, json};
use tuggraphics::chart::spec::{MAX_REFS, MAX_SET};

/// A commit ref, `commit:` + the sha as `git log %h` gave it.
pub fn commit_ref(sha: &str) -> String {
    format!("commit:{sha}")
}

/// Whether `text` is a sha a commit ref may carry: 4 to 40 hex characters.
/// A ledger row recorded with no sha, or a placeholder, gets no ref.
pub fn is_sha(text: &str) -> bool {
    (4..=40).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A path ref: `file:` for one file, `dir:` for a group of paths. The deck
/// lets the filesystem decide which it is ([P02]), so the prefix is for a
/// reader of the spec and costs nothing when the recipe's guess is wrong.
pub fn path_ref(path: &str, is_file: bool) -> String {
    if is_file {
        format!("file:{path}")
    } else {
        format!("dir:{path}")
    }
}

/// A command ref, `command:` + the command's text.
pub fn command_ref(command: &str) -> String {
    format!("command:{command}")
}

/// An arc ref, `arc:` + the arc's name.
pub fn arc_ref(name: &str) -> String {
    format!("arc:{name}")
}

/// A session ref: `session:` + the first eight characters of the id when
/// they hold a digit, and the whole id otherwise. The deck reads an eight
/// character short id only when it holds a digit (its `isSessionShortId`),
/// so a digitless prefix is spelled out in full, where it resolves.
pub fn session_ref(id: &str) -> String {
    let short: String = id.chars().take(8).collect();
    if short.chars().count() == 8 && short.chars().any(|c| c.is_ascii_digit()) {
        format!("session:{short}")
    } else {
        format!("session:{id}")
    }
}

/// [`session_ref`] when the spec would accept it, and `None` for an id the
/// spec cannot name: the short form must be eight hex characters and the long
/// form a uuid, so a scratch id like `s1` in an arc log gets no ref rather
/// than an invalid spec.
pub fn session_slot(id: &str) -> Option<String> {
    let r = session_ref(id);
    let value = &r["session:".len()..];
    let hex = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit());
    let short = value.len() == 8 && hex(value);
    let uuid = value.len() == 36 && {
        let parts: Vec<&str> = value.split('-').collect();
        parts.iter().map(|p| p.len()).eq([8, 4, 4, 4, 12]) && parts.iter().all(|p| hex(p))
    };
    (short || uuid).then_some(r)
}

/// How many ref members a spec may still carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefBudget {
    left: usize,
}

impl Default for RefBudget {
    fn default() -> Self {
        Self::new()
    }
}

impl RefBudget {
    /// A fresh budget of `MAX_REFS` members.
    pub fn new() -> Self {
        Self { left: MAX_REFS }
    }

    /// Take `n` members if they fit, and say whether they did.
    fn take(&mut self, n: usize) -> bool {
        if n > self.left {
            return false;
        }
        self.left -= n;
        true
    }

    /// The members still unspent.
    pub fn left(&self) -> usize {
        self.left
    }
}

/// One slot per bucket, parallel to the axis the buckets were made for.
///
/// A bucket of one member is that ref; of 2 to `MAX_SET` an array; past
/// `MAX_SET`, or once the budget cannot carry it, a `{kind, count}` form;
/// and an empty bucket is `null`. Members are deduplicated in order within
/// a bucket. The budget is spent from the last bucket backwards, so the
/// newest buckets keep their members.
pub fn set_slots(kind: &str, buckets: Vec<Vec<String>>, budget: &mut RefBudget) -> Vec<Value> {
    let mut slots = vec![Value::Null; buckets.len()];
    for (i, members) in buckets.into_iter().enumerate().rev() {
        let members = dedup(members);
        slots[i] = match members.len() {
            0 => Value::Null,
            n if n > MAX_SET || !budget.take(n) => json!({ "kind": kind, "count": n }),
            1 => Value::String(members.into_iter().next().unwrap_or_default()),
            _ => Value::Array(members.into_iter().map(Value::String).collect()),
        };
    }
    slots
}

/// One slot per sample, parallel to a histogram's `values`: each sample's
/// own ref while the budget lasts, and `null` after it. The samples come
/// newest first, so it is the oldest that lose their refs, and their bins
/// become counts.
pub fn sample_refs(samples: Vec<String>, budget: &mut RefBudget) -> Vec<Value> {
    samples
        .into_iter()
        .map(|sample| {
            if budget.take(1) {
                Value::String(sample)
            } else {
                Value::Null
            }
        })
        .collect()
}

fn dedup(members: Vec<String>) -> Vec<String> {
    let mut seen = Vec::with_capacity(members.len());
    for m in members {
        if !seen.contains(&m) {
            seen.push(m);
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shas(n: usize, tag: &str) -> Vec<String> {
        (0..n)
            .map(|i| commit_ref(&format!("{tag}{i:04x}")))
            .collect()
    }

    #[test]
    fn one_member_is_a_string_and_more_an_array() {
        let mut budget = RefBudget::new();
        let slots = set_slots(
            "commit",
            vec![shas(1, "a"), shas(3, "b"), vec![]],
            &mut budget,
        );
        assert_eq!(slots[0], json!("commit:a0000"));
        assert_eq!(
            slots[1],
            json!(["commit:b0000", "commit:b0001", "commit:b0002"])
        );
        assert_eq!(slots[2], Value::Null);
        assert_eq!(budget.left(), MAX_REFS - 4);
    }

    #[test]
    fn a_hundred_is_an_array_and_one_more_a_count() {
        let mut budget = RefBudget::new();
        let slots = set_slots(
            "commit",
            vec![shas(MAX_SET, "a"), shas(MAX_SET + 1, "b")],
            &mut budget,
        );
        assert_eq!(slots[0].as_array().map(Vec::len), Some(MAX_SET));
        assert_eq!(slots[1], json!({ "kind": "commit", "count": MAX_SET + 1 }));
        assert_eq!(budget.left(), MAX_REFS - MAX_SET);
    }

    #[test]
    fn the_budget_folds_the_oldest_buckets_into_counts_first() {
        // Nine buckets of 100: the budget of 800 keeps the newest eight.
        let mut budget = RefBudget::new();
        let buckets: Vec<Vec<String>> = (0..9).map(|i| shas(MAX_SET, &format!("d{i}"))).collect();
        let slots = set_slots("commit", buckets, &mut budget);
        assert_eq!(slots[0], json!({ "kind": "commit", "count": 100 }));
        for slot in &slots[1..] {
            assert_eq!(slot.as_array().map(Vec::len), Some(100));
        }
        assert_eq!(budget.left(), 0);
    }

    #[test]
    fn a_bucket_that_does_not_fit_leaves_the_budget_for_an_older_one_that_does() {
        let mut budget = RefBudget::new();
        let buckets = vec![shas(2, "old"), shas(MAX_SET, "mid"), shas(MAX_SET, "new")];
        for _ in 0..6 {
            set_slots("commit", vec![shas(MAX_SET, "x")], &mut budget);
        }
        // 200 left: the newest two take it all and the oldest still fits nothing.
        let slots = set_slots("commit", buckets, &mut budget);
        assert_eq!(slots[2].as_array().map(Vec::len), Some(100));
        assert_eq!(slots[1].as_array().map(Vec::len), Some(100));
        assert_eq!(slots[0], json!({ "kind": "commit", "count": 2 }));
    }

    #[test]
    fn members_are_deduplicated_in_order() {
        let mut budget = RefBudget::new();
        let slots = set_slots(
            "commit",
            vec![vec![
                "commit:a".into(),
                "commit:b".into(),
                "commit:a".into(),
            ]],
            &mut budget,
        );
        assert_eq!(slots[0], json!(["commit:a", "commit:b"]));
        assert_eq!(budget.left(), MAX_REFS - 2);
    }

    #[test]
    fn samples_keep_their_refs_until_the_budget_runs_out() {
        let mut budget = RefBudget::new();
        let slots = sample_refs(shas(MAX_REFS + 2, "s"), &mut budget);
        assert_eq!(slots.len(), MAX_REFS + 2);
        assert_eq!(slots[0], json!("commit:s0000"));
        assert!(slots[MAX_REFS - 1].is_string());
        assert_eq!(slots[MAX_REFS], Value::Null);
        assert_eq!(slots[MAX_REFS + 1], Value::Null);
        assert_eq!(budget.left(), 0);
    }

    #[test]
    fn session_ref_shortens_an_id_whose_prefix_holds_a_digit() {
        assert_eq!(
            session_ref("048e4155-f644-46f7-a839-d22ac02a564f"),
            "session:048e4155"
        );
        assert_eq!(
            session_ref("deadbeef-f644-46f7-a839-d22ac02a564f"),
            "session:deadbeef-f644-46f7-a839-d22ac02a564f"
        );
        assert_eq!(session_ref("short"), "session:short");
        assert_eq!(commit_ref("63de5762a"), "commit:63de5762a");
        assert_eq!(path_ref("src/app.ts", true), "file:src/app.ts");
        assert_eq!(path_ref("src", false), "dir:src");
        assert_eq!(command_ref("cargo build"), "command:cargo build");
        assert!(is_sha("abc1234"));
        assert!(!is_sha("abc"));
        assert!(!is_sha("unknown"));
        assert_eq!(
            arc_ref("chart-cross-references"),
            "arc:chart-cross-references"
        );
        assert_eq!(
            session_slot("048e4155-f644-46f7-a839-d22ac02a564f").as_deref(),
            Some("session:048e4155")
        );
        assert_eq!(
            session_slot("deadbeef-f644-46f7-a839-d22ac02a564f").as_deref(),
            Some("session:deadbeef-f644-46f7-a839-d22ac02a564f")
        );
        assert_eq!(session_slot("s1"), None);
        assert_eq!(session_slot("not-a-uuid-but-long-enough-to-be-one"), None);
    }
}
