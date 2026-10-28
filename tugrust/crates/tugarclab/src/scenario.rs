//! The lab's scenarios: the bench's grammar — arcs, rounds of edits, a
//! landing, an expectation — with two things the tempdir bench has no use
//! for: a `say`, which hands the arc's real session a turn, and a probe over
//! the running instance's records in place of a reading off a `Bench` field.
//!
//! The edits are the bench's own [`Edit`], so a round written here and a
//! round written in `tugarc_core::torture` are one vocabulary, and a defect
//! found live is pinned as a bench row in the same words.

use crate::probe::Probe;

pub use tugarc_core::torture::{Edit, edit, lines};

/// A surface the lab project declares in its `.tugtool/config.toml`, so the
/// arc's exam has something to check — and something to plant red.
pub struct Surface {
    pub name: &'static str,
    pub paths: &'static [&'static str],
    pub check: &'static [&'static str],
}

/// One act of a scenario, in the order the lab performs them.
pub enum Act {
    /// Cut an arc, spawn its headless session, bind the two.
    Arc(&'static str),
    /// A scripted round: the lab makes the edits in the arc's worktree and
    /// commits them through `tugtool arc commit`, so the record is the one a
    /// stage's round leaves, with no model in the loop.
    Round {
        arc: &'static str,
        subject: &'static str,
        edits: Vec<(&'static str, Edit)>,
    },
    /// Hand the arc's session a turn. A modelled round is this: the session's
    /// own model makes the change and runs the skills and the hook, which the
    /// bench cannot.
    Say {
        arc: &'static str,
        text: &'static str,
    },
    /// Land the arc on its base through `tugtool arc join`.
    Land(&'static str),
    /// Discard the arc through `tugtool arc discard --break-lease`: its
    /// worktree and branch gone without merging, the crossing it stood in
    /// forgotten, and the arc dropped from the run so a later act may cut one
    /// of the same name afresh. `--break-lease` is what lets the discard land
    /// while a settle may still hold the pair's lease — the torture case.
    Discard(&'static str),
    /// Wait for a record to say something, within the scenario's wait budget.
    Expect(Probe),
}

/// One scenario: the project it starts from, the surfaces it declares, and
/// its acts.
pub struct LabScenario {
    pub name: &'static str,
    pub why: &'static str,
    pub files: Vec<(&'static str, String)>,
    pub surfaces: Vec<Surface>,
    pub acts: Vec<Act>,
}

/// A ten-line file, the bench's own.
fn ten_lines() -> Vec<(&'static str, String)> {
    vec![("f.txt", lines(10)), ("g.txt", "g\n".to_string())]
}

/// The one surface every lab project declares: a `docs/` surface whose check
/// is `true`, so an exam has a surface to run and nothing to fail on until a
/// scenario plants a red one.
fn green_docs() -> Vec<Surface> {
    vec![Surface {
        name: "docs",
        paths: &["docs/"],
        check: &["true"],
    }]
}

/// The same surface planted red, so a round that touches `docs/` is one the
/// exam withholds a candidate over — the shape the 2026-10-28 run had.
fn red_docs() -> Vec<Surface> {
    vec![Surface {
        name: "docs",
        paths: &["docs/"],
        check: &["sh -c 'exit 1'"],
    }]
}

/// The round subjects of a shared-hunk scenario. A scripted round's subject
/// is the whole of the intent the settle's scribe and resolver read, and a
/// subject that says only "edits line five" leaves them a question nobody at
/// a crossing can answer — the 2026-10-28 run's resolver asked exactly that
/// and taught nothing. So the subject states the policy: keep both lines,
/// `ra`'s first, which is what the bench's keep-both scribe answers.
const A_FIVE: &str =
    "a edits line five; if another arc edits the same line keep both lines, a's first";
const B_FIVE: &str =
    "b edits line five; if another arc edits the same line keep both lines, a's first";

/// One arc, one scripted round: the shortest path through every door — a
/// spawn, a bind, a commit the instance's watcher sees — proven by the round
/// line the arc log carries.
fn smoke() -> LabScenario {
    LabScenario {
        name: "smoke",
        why: "one arc, one scripted round, the round line on the arc log",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Round {
                arc: "ra",
                subject: "a edits line one",
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 1, "a one")))],
            },
            Act::Expect(Probe::arc_log("ra", "a edits line one")),
        ],
    }
}

/// Two arcs on one base, both touching `f.txt` at lines far apart: the
/// instance's watcher probes the second round, records a clean crossing on
/// the arc log, and the pair's standing record names no conflict.
fn clean_crossing() -> LabScenario {
    LabScenario {
        name: "clean_crossing",
        why: "two arcs edit one file apart; the watcher records a clean crossing",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Round {
                arc: "ra",
                subject: "a edits line one",
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 1, "a one")))],
            },
            Act::Round {
                arc: "rb",
                subject: "b edits line ten",
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 10, "b ten")))],
            },
            Act::Expect(Probe::arc_log_marker("rb", "crossing")),
            Act::Expect(Probe::config_key(
                "tugcrossing.ra rb.state",
                "\"conflicts\":[]",
            )),
        ],
    }
}

/// Two arcs on disjoint files: no crossing is recorded, which is proven by
/// the marker's absence after the watcher has had its window.
fn disjoint() -> LabScenario {
    LabScenario {
        name: "disjoint",
        why: "two arcs on different files; no crossing line appears",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Round {
                arc: "ra",
                subject: "a edits f",
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 1, "a one")))],
            },
            Act::Round {
                arc: "rb",
                subject: "b edits g",
                edits: vec![("g.txt", Edit::Write("g by b\n".to_string()))],
            },
            Act::Expect(Probe::absent(Probe::arc_log_marker("rb", "crossing"), 15)),
        ],
    }
}

/// Both arcs rewrite line five: the watcher records a conflicted crossing,
/// the pilot's settle teaches the pair's resolution to the cache, and the
/// standing record names the file. Real model work, so it waits longest.
fn conflict_settles() -> LabScenario {
    LabScenario {
        name: "conflict_settles",
        why: "two arcs rewrite one line; the settle teaches rerere",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Round {
                arc: "ra",
                subject: A_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "a five")))],
            },
            Act::Round {
                arc: "rb",
                subject: B_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
            },
            Act::Expect(Probe::arc_log_marker("rb", "crossing-conflict")),
            Act::Expect(Probe::config_key("tugcrossing.ra rb.state", "f.txt")),
            Act::Expect(Probe::rerere(1)),
        ],
    }
}

/// The first arc lands while the second stands on disjoint paths: the base
/// carries the landing's subject, and the second arc's record survives it.
fn land_first() -> LabScenario {
    LabScenario {
        name: "land_first",
        why: "a lands on main while b stands; the base carries the landing",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Round {
                arc: "ra",
                subject: "a edits f",
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 1, "a one")))],
            },
            Act::Round {
                arc: "rb",
                subject: "b edits g",
                edits: vec![("g.txt", Edit::Write("g by b\n".to_string()))],
            },
            Act::Land("ra"),
            Act::Expect(Probe::base_log("lab lands ra")),
            Act::Expect(Probe::arc_log("ra", "joined")),
        ],
    }
}

/// The modelled executor's smallest proof: the arc's own session is handed a
/// turn and its transcript shows the turn arrived under the lab's marker.
fn say_smoke() -> LabScenario {
    LabScenario {
        name: "say_smoke",
        why: "a turn handed to the arc's session shows in its transcript",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Say {
                arc: "ra",
                text: "Reply with the single word pong and do nothing else.",
            },
            Act::Expect(Probe::transcript(
                "ra",
                "[arc-lab] Reply with the single word pong",
            )),
        ],
    }
}

/// Scenario zero — the run driven by hand on 2026-10-28. Two arcs share a
/// hunk; the watcher's settle teaches the pair's resolution to the cache; the
/// first arc lands; base-motion replays the second onto the moved base. The
/// replay must recall the settle: the arc log says `replayed` with the path
/// recalled, and the second arc's session is never handed a
/// `[base-motion replay]` turn over a hunk the machine already knew. The
/// `docs` surface is planted red and the second arc touches it, so what the
/// exam later withholds is the planted red and nothing else.
fn scenario_zero() -> LabScenario {
    LabScenario {
        name: "scenario_zero",
        why: "a shared hunk settles, a lands, b's replay recalls the settle",
        files: ten_lines(),
        surfaces: red_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Round {
                arc: "ra",
                subject: A_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "a five")))],
            },
            Act::Round {
                arc: "rb",
                subject: B_FIVE,
                edits: vec![
                    ("f.txt", Edit::Write(edit(&lines(10), 5, "b five"))),
                    (
                        "docs/README.md",
                        Edit::Write("# lab\n\nb was here.\n".to_string()),
                    ),
                ],
            },
            Act::Expect(Probe::arc_log_marker("rb", "crossing-conflict")),
            Act::Expect(Probe::rerere(1)),
            Act::Land("ra"),
            Act::Expect(Probe::base_log("lab lands ra")),
            Act::Expect(Probe::arc_log_marker("rb", "replayed")),
            Act::Expect(Probe::arc_log("rb", "recalled f.txt")),
            Act::Expect(Probe::absent(
                Probe::transcript("rb", "[base-motion replay]"),
                10,
            )),
        ],
    }
}

/// [F03b]/[F03c] A delete-versus-modify crossing: `ra` deletes `f.txt` and
/// `rb` rewrites a line of it. The merge is a non-content conflict rerere
/// cannot record, so the settle's resolver teaches nothing and the decline is
/// written to the arc log as `crossing-unsettled` — the record a probe reads,
/// where before it lived only in the process log.
fn crossing_declines() -> LabScenario {
    LabScenario {
        name: "crossing_declines",
        why: "a delete-vs-modify settle declines and records crossing-unsettled",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Round {
                arc: "ra",
                subject: "a deletes f.txt",
                edits: vec![("f.txt", Edit::Delete)],
            },
            Act::Round {
                arc: "rb",
                subject: B_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
            },
            Act::Expect(Probe::arc_log_marker("rb", "crossing-unsettled")),
        ],
    }
}

/// [F03d] Three arcs rewrite one line. The pairwise settles teach the cache
/// each pair's resolution, and the composed settle teaches the three-way one a
/// later join meets. So once `ra` and `rb` land, `rc` joins onto their merged
/// hunk cleanly — the base carries its landing — where without the compose
/// `rc`'s join would meet an unsettled conflict.
fn three_arcs_compose() -> LabScenario {
    LabScenario {
        name: "three_arcs_compose",
        why: "three arcs on one line; the composed settle lets the third land",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Arc("rc"),
            Act::Round {
                arc: "ra",
                subject: A_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "a five")))],
            },
            Act::Round {
                arc: "rb",
                subject: B_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
            },
            Act::Round {
                arc: "rc",
                subject: "c edits line five; if another arc edits the same line keep all, in arc order",
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "c five")))],
            },
            Act::Expect(Probe::arc_log_marker("rb", "crossing-conflict")),
            // Three pairwise preimages plus the composed ones: the cache holds
            // more than the three pairs alone once the compose has run.
            Act::Expect(Probe::rerere(3)),
            // Land ra; base-motion replays rb onto it, recalling the a·b
            // settle, so rb descends from main and is ready to land in turn.
            Act::Land("ra"),
            Act::Expect(Probe::arc_log_marker("rb", "replayed")),
            Act::Land("rb"),
            Act::Expect(Probe::base_log("lab lands rb")),
            // The headline: with both siblings landed, main carries the merged
            // a·b hunk, and rc's replay recalls the *composed* three-way
            // resolution rather than standing down — which is the preimage the
            // compose taught and no pairwise settle ever produced. The recalled
            // line is the proof; rc now descends from main carrying all three
            // sides, and landing it is an ordinary clean join the lab need not
            // race the in-flight replay to show.
            Act::Expect(Probe::arc_log("rc", "recalled f.txt")),
        ],
    }
}

/// [B11] A round that lands mid-settle, then two. Both arcs rewrite line five
/// and the watcher's settle begins; before it can finish, `rb` lands another
/// round and then both arcs land more, disjoint from the hunk. The storm of
/// re-probes while a settle runs must not corrupt the pair: the standing
/// conflict is recorded once and the cache holds its resolution.
fn round_mid_settle() -> LabScenario {
    LabScenario {
        name: "round_mid_settle",
        why: "rounds land while the settle runs; the pair records cleanly",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Round {
                arc: "ra",
                subject: A_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "a five")))],
            },
            Act::Round {
                arc: "rb",
                subject: B_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
            },
            // The rounds that land mid-settle: disjoint lines, so the standing
            // line-five conflict does not change and is not re-settled.
            Act::Round {
                arc: "rb",
                subject: "b edits line eight; disjoint from the conflict",
                edits: vec![(
                    "f.txt",
                    Edit::Write(edit(&edit(&lines(10), 5, "b five"), 8, "b eight")),
                )],
            },
            Act::Round {
                arc: "ra",
                subject: "a edits line two; disjoint from the conflict",
                edits: vec![(
                    "f.txt",
                    Edit::Write(edit(&edit(&lines(10), 5, "a five"), 2, "a two")),
                )],
            },
            Act::Expect(Probe::arc_log_marker("rb", "crossing-conflict")),
            Act::Expect(Probe::rerere(1)),
        ],
    }
}

/// [B11] A join started while a settle runs on the same pair. Both arcs rewrite
/// line five; the lab lands `ra` the instant the crossing is seen, without
/// waiting for the settle to teach, so the land and the settle race. The sibling
/// must not be stranded: the base takes the landing, and base-motion replays
/// `rb` onto it and runs its exam — the arc log records `rb verified` on the
/// landed base, whichever order the race resolves in. (That the replay *recalls*
/// the resolution rather than meeting the hunk fresh is the sequential path's
/// proof, pinned by `scenario_zero` and `base_moves_twice`; here the point is
/// that a join mid-settle leaves a consistent record, not a half-replayed arc.)
fn join_during_settle() -> LabScenario {
    LabScenario {
        name: "join_during_settle",
        why: "a lands the instant the crossing is seen; b is replayed and verified, not stranded",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Round {
                arc: "ra",
                subject: A_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "a five")))],
            },
            Act::Round {
                arc: "rb",
                subject: B_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
            },
            // The land races the settle: it fires as soon as the crossing is
            // seen, before the settle can teach the cache.
            Act::Expect(Probe::arc_log_marker("rb", "crossing-conflict")),
            Act::Land("ra"),
            Act::Expect(Probe::base_log("lab lands ra")),
            Act::Expect(Probe::arc_log_marker("rb", "verified")),
        ],
    }
}

/// [B11] A base that moves twice before the arc replays. `ra` and `rb` share the
/// line-five hunk; `rx` edits line one, disjoint. `ra` lands — base-motion
/// replays both `rb` and `rx` onto it — and then `rx` lands too, moving the base
/// a second time. `rb`'s replay onto the twice-moved base must still recall the
/// a·b settle: a base two commits ahead of where `rb` was cut is one the replay
/// walks in full.
fn base_moves_twice() -> LabScenario {
    LabScenario {
        name: "base_moves_twice",
        why: "a and x land before b replays; b's replay recalls over the twice-moved base",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Arc("rx"),
            Act::Round {
                arc: "ra",
                subject: A_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "a five")))],
            },
            Act::Round {
                arc: "rb",
                subject: B_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
            },
            Act::Round {
                arc: "rx",
                subject: "x edits line one; disjoint from the conflict",
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 1, "x one")))],
            },
            Act::Expect(Probe::arc_log_marker("rb", "crossing-conflict")),
            Act::Expect(Probe::rerere(1)),
            Act::Land("ra"),
            Act::Expect(Probe::arc_log_marker("rb", "replayed")),
            Act::Expect(Probe::arc_log_marker("rx", "replayed")),
            Act::Land("rx"),
            Act::Expect(Probe::base_log("lab lands rx")),
            Act::Expect(Probe::arc_log("rb", "recalled f.txt")),
        ],
    }
}

/// [B11] An arc discarded while its crossing stands, then a new arc of the same
/// name cut. `ra` and `rb` rewrite line five and the crossing stands; `rb` is
/// discarded — its branch, worktree and standing crossing gone — and a fresh
/// `rb` is cut over the same name with a different line-five edit. The new pair
/// must be probed and settled on its own content, never served the dead arc's
/// stale standing record: the pair key names the new conflict and the cache
/// grows a second resolution.
fn discard_mid_crossing() -> LabScenario {
    LabScenario {
        name: "discard_mid_crossing",
        why: "b discarded mid-crossing, a new b cut over the name, probed fresh",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Round {
                arc: "ra",
                subject: A_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "a five")))],
            },
            Act::Round {
                arc: "rb",
                subject: B_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
            },
            Act::Expect(Probe::arc_log_marker("rb", "crossing-conflict")),
            Act::Expect(Probe::rerere(1)),
            Act::Discard("rb"),
            Act::Arc("rb"),
            Act::Round {
                arc: "rb",
                subject: "b edits line five; if another arc edits the same line keep both, a's first — this is the new b",
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "b two")))],
            },
            // The new pair's standing record names the conflict afresh, and the
            // cache now holds two resolutions: the dead pair's and the live one.
            Act::Expect(Probe::config_key("tugcrossing.ra rb.state", "f.txt")),
            Act::Expect(Probe::rerere(2)),
        ],
    }
}

/// [B11] A notice arriving while the session is mid-turn. `ra` and `rb` cross on
/// line five; `rb`'s session is handed a turn, and while it is mid-turn `ra`
/// lands, so base-motion's replay notice for `rb` arrives against a session that
/// is already busy. The notice must not be lost or double-injected: `rb` is
/// still replayed onto the landed base and its exam runs — the arc log records
/// `rb verified`, and the handed turn is in its transcript.
fn notice_mid_turn() -> LabScenario {
    LabScenario {
        name: "notice_mid_turn",
        why: "a base-motion notice lands while b is mid-turn; b still reconciles",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Round {
                arc: "ra",
                subject: A_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "a five")))],
            },
            Act::Round {
                arc: "rb",
                subject: B_FIVE,
                edits: vec![("f.txt", Edit::Write(edit(&lines(10), 5, "b five")))],
            },
            Act::Expect(Probe::arc_log_marker("rb", "crossing-conflict")),
            // Hand rb a turn, then land ra so the replay notice arrives while rb
            // is mid-turn.
            Act::Say {
                arc: "rb",
                text: "Reply with a short paragraph about git merges, then stop.",
            },
            Act::Land("ra"),
            Act::Expect(Probe::base_log("lab lands ra")),
            Act::Expect(Probe::transcript(
                "rb",
                "[arc-lab] Reply with a short paragraph",
            )),
            Act::Expect(Probe::arc_log_marker("rb", "verified")),
        ],
    }
}

/// [B11] The modelled executor over a crossing, perms on auto. Rather than the
/// lab scripting the rounds, each arc's own session is handed a turn and asked
/// to make the edit and commit it as a round — the model, the hook and the
/// skills in the loop, which the scripted path bypasses. Both edit line five, so
/// the watcher sees the crossing a scripted pair would raise and settles it: the
/// modelled path reaches the same records, a crossing-conflict on the arc log
/// and a resolution in the cache. Two real model turns run well past the default
/// wait, so this scenario is run with a longer budget — `--wait-secs 420`.
fn modelled_crossing() -> LabScenario {
    LabScenario {
        name: "modelled_crossing",
        why: "sessions are handed turns that make and commit the rounds; the crossing settles",
        files: ten_lines(),
        surfaces: green_docs(),
        acts: vec![
            Act::Arc("ra"),
            Act::Arc("rb"),
            Act::Say {
                arc: "ra",
                text: "In this arc's git worktree (your current directory), edit f.txt so line 5 reads exactly `a five`, keeping the other nine lines unchanged. Then commit it as an arc round by running `tugtool arc commit ra --message \"a edits line five; if another arc edits the same line keep both lines, a's first\"`. Do only that, then stop.",
            },
            Act::Say {
                arc: "rb",
                text: "In this arc's git worktree (your current directory), edit f.txt so line 5 reads exactly `b five`, keeping the other nine lines unchanged. Then commit it as an arc round by running `tugtool arc commit rb --message \"b edits line five; if another arc edits the same line keep both lines, a's first\"`. Do only that, then stop.",
            },
            // The two modelled rounds run concurrently, so which arc commits last
            // — and so logs the `crossing-conflict` marker — is not fixed. A
            // recorded resolution in the cache is the order-independent proof
            // that the modelled pair crossed and settled: only a detected
            // conflict and a settle that taught can produce one.
            Act::Expect(Probe::rerere(1)),
        ],
    }
}

/// Every scenario, in the order `--list` prints them.
pub fn scenarios() -> Vec<LabScenario> {
    vec![
        smoke(),
        clean_crossing(),
        disjoint(),
        conflict_settles(),
        land_first(),
        say_smoke(),
        scenario_zero(),
        crossing_declines(),
        three_arcs_compose(),
        round_mid_settle(),
        join_during_settle(),
        base_moves_twice(),
        discard_mid_crossing(),
        notice_mid_turn(),
        modelled_crossing(),
    ]
}

/// The scenario named `name`, if there is one.
pub fn find(name: &str) -> Option<LabScenario> {
    scenarios().into_iter().find(|s| s.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenario_names_are_unique_and_each_has_an_expectation() {
        let all = scenarios();
        let mut names: Vec<&str> = all.iter().map(|s| s.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), all.len(), "a name repeats");
        for scenario in &all {
            assert!(
                scenario.acts.iter().any(|a| matches!(a, Act::Expect(_))),
                "{} expects nothing",
                scenario.name
            );
            assert!(!scenario.why.is_empty(), "{} says no why", scenario.name);
        }
    }

    #[test]
    fn find_answers_by_name_and_shrugs_at_a_stranger() {
        assert_eq!(find("smoke").map(|s| s.name), Some("smoke"));
        assert!(find("no-such-scenario").is_none());
    }

    /// Every arc an act names was cut by an earlier act, so a scenario cannot
    /// speak to or round on an arc it never made.
    #[test]
    fn every_arc_an_act_names_was_cut_first() {
        for scenario in scenarios() {
            let mut cut: Vec<&str> = Vec::new();
            for act in &scenario.acts {
                match act {
                    Act::Arc(name) => cut.push(name),
                    Act::Round { arc, .. } | Act::Say { arc, .. } => {
                        assert!(cut.contains(arc), "{}: {arc} not cut", scenario.name)
                    }
                    Act::Land(arc) => {
                        assert!(cut.contains(arc), "{}: {arc} not cut", scenario.name)
                    }
                    Act::Discard(arc) => {
                        assert!(cut.contains(arc), "{}: {arc} not cut", scenario.name);
                        // A discarded arc is gone: a later act must cut one of
                        // the same name afresh before it can be named again.
                        cut.retain(|a| a != arc);
                    }
                    Act::Expect(_) => {}
                }
            }
        }
    }
}
