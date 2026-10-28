//! `tugarclab` — the live arc crossing lab.
//!
//! ```text
//! tugarclab --list
//! tugarclab <scenario> [--instance <id>] [--keep] [--wait-secs <n>]
//! ```
//!
//! Sets up a lab project under `/tmp/arc-lab/<run-id>/`, spawns headless
//! sessions on the named instance, cuts and binds arcs, drives rounds and
//! landings through `tugtool`, reads the outcome from the records, prints a
//! timeline with a verdict, and sweeps the run's sessions unless `--keep`.
//! Exits 1 on any red, 2 when it could not run at all.
//!
//! A dev crate, run by `just arc-lab`. The `tugtool` it drives is the one
//! built beside it, never the app's on `PATH`.

mod executor;
mod instance;
mod probe;
mod project;
mod scenario;
mod timeline;

use std::collections::HashMap;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::Parser;

use executor::Lab;
use instance::Instance;
use project::LabProject;
use timeline::Timeline;

#[derive(Parser, Debug)]
#[command(
    name = "tugarclab",
    about = "Run one arc crossing scenario against a running Tug instance"
)]
struct Cli {
    /// The scenario to run (see `--list`).
    scenario: Option<String>,
    /// The instance to run against, by registry id.
    #[arg(long, default_value = "release-main")]
    instance: String,
    /// List the scenarios and exit.
    #[arg(long)]
    list: bool,
    /// Leave the run's sessions in the ledger instead of trashing them.
    #[arg(long)]
    keep: bool,
    /// How long one expectation may wait before it is a red.
    #[arg(long, default_value_t = 120)]
    wait_secs: u64,
    /// The run id; defaults to `<scenario>-<unix millis>`.
    #[arg(long)]
    run_id: Option<String>,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    if cli.list {
        for scenario in scenario::scenarios() {
            println!("{:<24} {}", scenario.name, scenario.why);
        }
        return ExitCode::SUCCESS;
    }
    let Some(name) = cli.scenario.as_deref() else {
        eprintln!("name a scenario, or pass --list");
        return ExitCode::from(2);
    };
    match run(&cli, name) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(message) => {
            eprintln!("arc-lab: {message}");
            ExitCode::from(2)
        }
    }
}

/// Set up, run, sweep, report. `Ok(green)`.
fn run(cli: &Cli, name: &str) -> Result<bool, String> {
    let scenario = scenario::find(name).ok_or_else(|| {
        format!(
            "no scenario named {name}; known: {}",
            scenario::scenarios()
                .iter()
                .map(|s| s.name)
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;
    let instance = Instance::find(&cli.instance)?;
    let tugtool = instance::tugtool_path()?;
    let run_id = cli.run_id.clone().unwrap_or_else(|| {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        format!("{name}-{millis}")
    });
    let run_dir = project::run_dir(&run_id);
    std::fs::create_dir_all(&run_dir)
        .map_err(|e| format!("creating {}: {e}", run_dir.display()))?;
    let project = LabProject::build(&run_dir, &scenario.files, &scenario.surfaces)?;

    let mut timeline = Timeline::start(name);
    timeline.act(
        "lab",
        format!(
            "run {run_id} against {} (tugcast :{}) at {}",
            instance.id,
            instance.port,
            project.root.display()
        ),
    );
    let api = instance.session_api();
    let mut lab = Lab {
        api,
        project,
        tugtool,
        owner: Lab::owner_for(&run_id),
        run_dir,
        wait_secs: cli.wait_secs,
        arcs: HashMap::new(),
        timeline,
    };

    // An act that fails is a red the timeline carries, and the sweep still
    // runs: a run that could not finish must not leave its sessions behind.
    let walked = lab.run(&scenario);
    if let Err(message) = &walked {
        lab.timeline
            .verdict("lab", format!("act failed: {message}"), false);
    }
    if let Err(message) = lab.cleanup(cli.keep) {
        lab.timeline
            .verdict("lab", format!("sweep failed: {message}"), false);
    }
    let path = lab.write_timeline()?;
    println!("{}", lab.timeline.render());
    println!("timeline: {}", path.display());
    Ok(lab.timeline.green())
}
