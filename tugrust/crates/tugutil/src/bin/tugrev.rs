//! `tugrev` — the `.rev` interpreter, spelled the way it is written.
//!
//! The same verb as `tugutil file rev`, through the same function: a rev in a
//! heredoc reads as one thing, and `tugrev <<'REV'` is that thing. The name is
//! not `rev` because `/usr/bin/rev` reverses lines on every macOS and Linux
//! install and would report success on a program it printed backwards.

use std::process::ExitCode;

use clap::Parser;

const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), " (", env!("TUG_COMMIT"), ")");

#[derive(Parser)]
#[command(name = "tugrev")]
#[command(version = VERSION)]
#[command(about = "tugrev — run a .rev program and report exactly which files changed")]
#[command(
    long_about = "tugrev — run a .rev edit program.\n\nA program is a sequence of file blocks holding literal and regex\nsubstitutions, line-addressed inserts, deletes and moves, and whole-file\ncreate/write ops. Every address resolves against the file's original bytes\nbefore anything is written, so a program either applies entirely or writes\nnothing. A successful run prints the diff it made and one TUG-FILE-RECEIPT\nline naming the files whose bytes moved.\n\nThe same verb is spelled `tugutil file rev`."
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
    let result = tugutil::rev::read_program(args.file.as_deref())
        .and_then(|program| tugutil::rev::run(&program, args.preview));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::from(err.exit_code())
        }
    }
}
