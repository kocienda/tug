//! `tugedit` — the edit-program interpreter under its own name.
//!
//! The same verb as `tugtool file edit`, through the same function: an edit
//! program in a heredoc reads as one thing, and `tugedit <<'EDIT'` is that
//! thing. The `--patch` mode stays on `tugtool file edit`, which owns the
//! git-apply plumbing it rides on.

use std::process::ExitCode;

use clap::Parser;

const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), " (", env!("TUG_COMMIT"), ")");

#[derive(Parser)]
#[command(name = "tugedit")]
#[command(version = VERSION)]
#[command(about = "tugedit — run an edit program and report exactly which files changed")]
#[command(
    long_about = "tugedit — run an edit program.\n\nA program is a sequence of file blocks holding literal and regex\nsubstitutions, line-addressed inserts, deletes and moves, and whole-file\ncreate/write ops. Every address resolves against the file's original bytes\nbefore anything is written, so a program either applies entirely or writes\nnothing. A successful run prints the diff it made and one TUG-FILE-RECEIPT\nline naming the files whose bytes moved.\n\nThe same verb is spelled `tugtool file edit`."
)]
struct Args {
    /// Show the diff the program would produce and write nothing.
    #[arg(long)]
    preview: bool,
    /// The program to run (default: stdin, or `-`).
    file: Option<String>,
}

fn main() -> ExitCode {
    let args = Args::parse();
    // The program is held rather than piped through: the TUG-EDIT-ERROR marker
    // carries it, and a failure nobody can see the program for is a failure
    // nobody can diagnose.
    let program = match tugtool::edit::read_program(args.file.as_deref()) {
        Ok(program) => program,
        Err(err) => {
            tugtool::edit_error_marker::report(&err, "");
            return ExitCode::from(err.exit_code());
        }
    };
    match tugtool::edit::run(&program, args.preview) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            tugtool::edit_error_marker::report(&err, &program);
            ExitCode::from(err.exit_code())
        }
    }
}
