//! CLI command implementations

pub mod ask;
pub mod changesets;
pub mod deck_motion;
pub mod file;
pub mod file_probe;
pub mod file_run;
pub mod gate;
pub mod hook;
pub mod init;
pub mod instance;
pub mod restore_names;
pub mod state_dir;
pub mod sweep;
pub mod tell;

pub use ask::run_ask;
pub use changesets::run_changesets;
pub use deck_motion::run_deck_motion;
pub use file::run_file;
pub use gate::{GateCommands, run_gate};
pub use hook::{HookCommands, run_hook};
pub use init::run_init;
pub use instance::{InstanceCommands, run_instance};
pub use restore_names::run_restore_names;
pub use state_dir::run_state_dir;
pub use sweep::run_sweep;
pub use tell::run_tell;
