//! The running deck (`tugtool deck …`) — dispatch to the command modules,
//! preserving their `Result<i32, _>` → exit-code contract.
//!
//! One family so far: `deck motion`, which reads the page's own render-cost
//! and animation census off `window.__tugMotion` through `POST /api/eval`.

use std::process::ExitCode;

use crate::changes::AppError;
use crate::cli::DeckCommands;
use crate::commands;

pub fn dispatch(cmd: DeckCommands, json: bool) -> ExitCode {
    let command = match &cmd {
        DeckCommands::Motion(cmd) => commands::deck_motion::command_name(cmd),
    };
    let result = match cmd {
        DeckCommands::Motion(cmd) => commands::run_deck_motion(cmd, json),
    };

    match result {
        Ok(code) => ExitCode::from(code as u8),
        Err(e) => AppError::from(e).report(command, json),
    }
}
