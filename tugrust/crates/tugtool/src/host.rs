//! Host plumbing — instance discovery, the build gate, project state, and the
//! `tell` bridge (`tugtool host …`). Dispatches to the command modules, preserving
//! their `Result<i32, _>` → exit-code contract (the code the handler returns is
//! the process exit code; any error is exit 1).

use std::process::ExitCode;

use crate::cli::HostCommands;
use crate::commands;

pub fn dispatch(cmd: HostCommands, json: bool, quiet: bool) -> ExitCode {
    let result = match cmd {
        HostCommands::Init { force, check } => commands::run_init(force, check, json, quiet),
        HostCommands::Ask {
            title,
            description,
            option,
            timeout_secs,
            unattended,
            port,
            instance,
        } => commands::run_ask(
            title,
            description,
            option,
            timeout_secs,
            unattended,
            port,
            instance,
        ),
        HostCommands::Tell {
            action,
            port,
            instance,
            param,
        } => commands::run_tell(action, port, instance, param, json),
        HostCommands::Instance(cmd) => commands::run_instance(cmd),
        HostCommands::Gate(cmd) => Ok(commands::run_gate(cmd, json, quiet)),
        HostCommands::Sweep {
            yes,
            json: sweep_json,
            dry_run,
            quiet: sweep_quiet,
        } => commands::run_sweep(yes, json || sweep_json, quiet || sweep_quiet, dry_run),
        HostCommands::StateDir => commands::run_state_dir(json, quiet),
        HostCommands::Changesets { port, instance } => {
            commands::run_changesets(port, instance, json)
        }
    };

    match result {
        Ok(code) => ExitCode::from(code as u8),
        Err(e) => {
            eprintln!("error: {}", e);
            ExitCode::from(1)
        }
    }
}
