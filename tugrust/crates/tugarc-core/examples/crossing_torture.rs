//! Run the crossing torture bench and print its table.
//!
//! ```text
//! cargo run -p tugarc-core --example crossing_torture [-- <name-substring>...]
//! ```
//!
//! Every scenario builds its own repository in a tempdir and walks two or
//! three arcs round by round through the probe, the pair ladder (with a
//! stand-in for the scribe named in the row), a landing, and the second
//! arc's join with no scribe at all. The scenarios themselves are in
//! `tugarc_core::torture`, and the integration test of the same name asserts
//! each one's expectation.

use tugarc_core::torture;

fn main() {
    let wanted: Vec<String> = std::env::args().skip(1).collect();
    let mut failed = 0;
    println!(
        "{:<34} {:>7} {:>7} {:>7}  {:<40} verdict",
        "scenario", "clean", "confl", "blocks", "join rungs"
    );
    for scenario in torture::scenarios() {
        if !wanted.is_empty() && !wanted.iter().any(|w| scenario.name.contains(w.as_str())) {
            continue;
        }
        let bench = (scenario.run)();
        let join = bench.joins.last();
        let blocks = join.map_or("-".to_string(), |j| {
            format!("{}→{}", j.blocks.0, j.blocks.1)
        });
        let rungs = join.map_or("-".to_string(), |j| {
            let mut parts: Vec<String> = j
                .resolved
                .iter()
                .map(|(p, by)| format!("{p} {}", by.as_str()))
                .collect();
            parts.extend(j.unresolved.iter().map(|p| format!("{p} UNRESOLVED")));
            if parts.is_empty() {
                "clean".to_string()
            } else {
                parts.join(", ")
            }
        });
        let verdict = if bench.failures.is_empty() {
            "ok".to_string()
        } else {
            failed += 1;
            format!("FAIL: {}", bench.failures.join("; "))
        };
        println!(
            "{:<34} {:>7} {:>7} {:>7}  {:<40} {}",
            scenario.name, bench.clean_crossings, bench.conflict_crossings, blocks, rungs, verdict
        );
        println!("{:<34} {}", "", scenario.why);
        for note in &bench.notes {
            println!("{:<34}   {note}", "");
        }
    }
    if failed > 0 {
        eprintln!("{failed} scenario(s) missed their expectation");
        std::process::exit(1);
    }
}
