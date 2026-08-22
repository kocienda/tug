//! tugutil — the unified Tug developer CLI (changes & commits, dashes, host plumbing).

mod apptest;
mod changes;
mod cli;
mod commands;
mod dash;
mod draft;
mod host;
mod output;
mod plan;
mod splash;

use std::process::ExitCode;

use cli::Commands;

fn main() -> ExitCode {
    let cli = cli::parse();
    let json = cli.json;
    let quiet = cli.quiet;

    match cli.command {
        None => {
            // No subcommand — show the splash screen.
            if !quiet {
                splash::show_splash();
                println!("Use --help for usage information");
            }
            ExitCode::SUCCESS
        }

        // Changes & commits — the git surface (tugchanges_core).
        Some(Commands::Changes {
            session,
            project,
            all,
            diff,
        }) => changes::finish(changes::run_changes(session, project, all, diff, json)),
        Some(Commands::Preflight {
            session,
            project,
            log_limit,
        }) => changes::finish(changes::run_preflight(session, project, log_limit, json)),
        Some(Commands::Commit {
            message,
            session,
            project,
            paths,
            all,
            include_unattributed,
            leave_unattributed,
            tree,
            hunks,
        }) => changes::finish(changes::run_commit(
            message,
            session,
            project,
            paths,
            all,
            include_unattributed,
            leave_unattributed,
            tree,
            hunks,
            json,
        )),
        Some(Commands::Claim {
            paths,
            session,
            project,
        }) => changes::finish(changes::run_claim(paths, session, project, json)),
        Some(Commands::Disclaim {
            paths,
            session,
            project,
        }) => changes::finish(changes::run_disclaim(paths, session, project, json)),
        Some(Commands::Log { limit, range }) => {
            changes::finish(changes::run_log(limit, range, json))
        }
        Some(Commands::Diff {
            range,
            staged,
            session,
            project,
        }) => changes::finish(changes::run_diff(range, staged, session, project, json)),
        Some(Commands::Draft(cmd)) => changes::finish(match cmd {
            cli::DraftCommands::Set {
                owner,
                project,
                message,
                include,
                exclude,
                port,
                instance,
            } => draft::run_set(
                owner, project, message, include, exclude, port, instance, json,
            ),
            cli::DraftCommands::Show { owner, project } => draft::run_show(owner, project, json),
            cli::DraftCommands::Clear {
                owner,
                project,
                port,
                instance,
            } => draft::run_clear(owner, project, port, instance, json),
        }),

        // File lifecycle verbs — receipts are the attribution surface.
        Some(Commands::File(cmd)) => changes::finish(commands::run_file(cmd)),

        // Dashes (tugdash_core) and host plumbing (command modules).
        Some(Commands::Dash(cmd)) => dash::dispatch(cmd, json, quiet),
        Some(Commands::Plan(cmd)) => plan::dispatch(cmd, json),
        Some(Commands::Host(cmd)) => host::dispatch(cmd, json, quiet),

        // The app-test results ledger.
        Some(Commands::Apptest(cmd)) => changes::finish(match cmd {
            cli::ApptestCommands::Record => apptest::run_record(),
            cli::ApptestCommands::History { root, files, .. } => apptest::run_history(root, files),
        }),
    }
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    #[test]
    fn verify_cli() {
        crate::cli::Cli::command().debug_assert();
    }
}
