//! The one place a CLI test spawns the `tugtool` binary.
//!
//! A test that spawns a real binary with the ambient environment intact runs
//! **as the developer's session**. `tripwire_cli.rs` did exactly that: it ran
//! `tugtool dash create` in a temp repo with neither `TUG_SESSION_ID` nor the
//! instance registry scrubbed, so on a machine where the suite runs from
//! inside a Session card — which is most of them — the spawned binary reached
//! the real registry and posted a bind naming a scratch dash in a directory
//! that would be gone a second later.
//!
//! Two other CLI test files had reached the right answer independently and
//! the rest had never been asked. So the answer is here now, once, and
//! `tugcore::cli_test_env_scan` refuses a spawn spelled any other way.
//!
//! `TUG_DATA_DIR` and `TMPDIR` are deliberately *not* set here: where a
//! test's state should land is the test's business, and several want the
//! real defaults. What is not the test's business is which session it is.
#![allow(dead_code)]

use std::process::Command;

/// A `Command` for the workspace's `tugtool`, with the ambient session
/// scrubbed.
///
/// `TUG_SESSION_ID` names the segment the *test runner's* card is seated on,
/// and `TUG_INSTANCE_ID` names the app that owns it. Neither has anything to
/// do with a temp repo, and a verb handed them will happily claim, bind, or
/// attribute against one.
pub fn tugtool() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_tugtool"));
    cmd.env_remove("TUG_SESSION_ID");
    cmd.env_remove("TUG_INSTANCE_ID");
    cmd
}

/// The `tugtool` binary's path, for a test that needs to place it on `PATH`
/// or hand it to something else rather than run it.
///
/// A path is not a spawn — nothing is inheriting an environment here — but it
/// lives beside [`tugtool`] so the two spellings of "where is the binary"
/// stay one answer.
pub fn tugtool_bin() -> &'static str {
    env!("CARGO_BIN_EXE_tugtool")
}

/// The same, for `tugedit` — `tugtool file edit` under its own name, and a
/// binary with the same ambient-session exposure.
pub fn tugedit() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_tugedit"));
    cmd.env_remove("TUG_SESSION_ID");
    cmd.env_remove("TUG_INSTANCE_ID");
    cmd
}
