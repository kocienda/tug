//! The crossing torture bench as a verdict: every scenario in
//! `tests/torture/crossing.rs` runs under nextest and its expectations must
//! hold. The `crossing_torture` example prints the same scenarios as a table.

#[path = "torture/crossing.rs"]
mod torture;

fn run(name: &str) {
    let scenario = torture::scenarios()
        .into_iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| panic!("no scenario named {name}"));
    let bench = (scenario.run)();
    assert!(
        bench.failures.is_empty(),
        "{name} ({}): {}\nnotes: {:#?}",
        scenario.why,
        bench.failures.join("; "),
        bench.notes
    );
}

macro_rules! scenario_tests {
    ($($name:ident),* $(,)?) => {
        $(
            #[test]
            fn $name() {
                run(stringify!($name));
            }
        )*
    };
}

scenario_tests![
    disjoint,
    clean_overlap,
    a_lands_first,
    b_lands_first,
    resolver_finishes,
    prose_scribe,
    ours_only_scribe,
    reformatting_scribe,
    over_cap_rungs_only,
    over_cap_with_resolver,
    drift_1,
    drift_2,
    drift_3,
    drift_4,
    drift_8,
    second_hunk_1,
    second_hunk_5,
    conflict_goes_away_and_returns,
    three_arcs,
    discarded_arc_taught_the_cache,
    rename_vs_edit,
    delete_vs_modify,
    add_add,
    mode_flip_vs_edit,
    crlf,
    binary,
    random_seed_1,
    random_seed_2,
    random_seed_3,
];

/// The test list above and the scenario list agree, so a scenario added to
/// the bench cannot go unasserted.
#[test]
fn every_scenario_has_a_test() {
    let listed = [
        "disjoint",
        "clean_overlap",
        "a_lands_first",
        "b_lands_first",
        "resolver_finishes",
        "prose_scribe",
        "ours_only_scribe",
        "reformatting_scribe",
        "over_cap_rungs_only",
        "over_cap_with_resolver",
        "drift_1",
        "drift_2",
        "drift_3",
        "drift_4",
        "drift_8",
        "second_hunk_1",
        "second_hunk_5",
        "conflict_goes_away_and_returns",
        "three_arcs",
        "discarded_arc_taught_the_cache",
        "rename_vs_edit",
        "delete_vs_modify",
        "add_add",
        "mode_flip_vs_edit",
        "crlf",
        "binary",
        "random_seed_1",
        "random_seed_2",
        "random_seed_3",
    ];
    let named: Vec<&str> = torture::scenarios().iter().map(|s| s.name).collect();
    assert_eq!(named, listed);
}
