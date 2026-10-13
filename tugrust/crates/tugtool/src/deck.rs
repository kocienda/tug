//! The running deck (`tugtool deck …`) — dispatch to the command modules,
//! preserving their `Result<i32, _>` → exit-code contract.
//!
//! `deck motion` reads the page's own render-cost and animation census off
//! `window.__tugMotion` through `POST /api/eval`; `deck pages` lists the
//! pages tugcast's WebSockets carry, off `GET /api/pages`.

use std::process::ExitCode;

use crate::changes::AppError;
use crate::cli::DeckCommands;
use crate::commands;

pub fn dispatch(cmd: DeckCommands, json: bool) -> ExitCode {
    let command = match &cmd {
        DeckCommands::Motion(cmd) => commands::deck_motion::command_name(cmd),
        DeckCommands::Pages { .. } => "deck pages",
    };
    let result = match cmd {
        DeckCommands::Motion(cmd) => commands::run_deck_motion(cmd, json),
        DeckCommands::Pages { target } => {
            commands::run_deck_pages(target.port, target.instance, json)
        }
    };

    match result {
        Ok(code) => ExitCode::from(code as u8),
        Err(e) => AppError::from(e).report(command, json),
    }
}
